/**
 * ttsPipeline — streaming TTS pipeline (v0.4.0-rc1, batch 1).
 *
 * Replaces the bulk "synthesize the whole reply, then encode opus"
 * path in esp32ListenHandler.streamTtsToOpusFrames with a 3-stage
 * streaming pipeline:
 *
 *   ttsTextQueue  ──ttsTextWorker──▶  ttsAudioQueue  ──ttsAudioWorker──▶  ws
 *   (text chunks)    (synthesize)      (PCM chunks)      (opus encode + send)
 *
 * The two workers run as detached async loops; they consume from
 * their input queue and produce to the next queue. A `close()` on
 * the handle signals both workers to exit after draining their input.
 * An `abort()` short-circuits: pending text is dropped, in-flight
 * TTS yields are checked for session.aborted between chunks.
 *
 * Opt-in gate:
 *   `cfg.useStreamingTts === true` enables this path. The default
 *   is false; the legacy streamTtsToOpusFrames path is unchanged.
 *   See esp32ListenHandler.ts and inbound.ts for the call-site
 *   `if (cfg.useStreamingTts)` branch.
 *
 * The pipeline is intentionally conservative on first commit:
 *   - Sends a single tts.start before the first chunk,
 *   - One tts.sentence_start per chunkSentence() emission,
 *   - One tts.stop after the last opus frame,
 *   - markTtsEnded(session, lastText, log) on close (Bug 2 compat).
 *
 * Future batches (not in this commit) can add per-sentence pacing,
 * Silero VAD integration, and metrics. The 3-queue skeleton is
 * the foundation those will build on.
 */

import type { WebSocket } from "ws";
import type { SessionContext } from "./session.js";
import { markTtsEnded, transitionTo } from "./session.js";
import { sendLlmMessage, sendTtsOpusFrames, sendTtsSentenceStart, sendTtsStop } from "./outbound.js";
import { OpusCodec, frameSizeBytes } from "./audio.js";
import type { TTSProvider } from "./tts/types.js";
import { cleanForTTS, DEFAULT_CLEANER_CONFIG, type CleanerConfig } from "./textCleaner.js";

export type SentenceType = "FIRST" | "MIDDLE" | "LAST";

export interface SentenceChunk {
  text: string;
  type: SentenceType;
}

export interface TtsPipelineConfig {
  /** Opt-in gate. Caller MUST check this before invoking startTtsPipeline. */
  useStreamingTts: boolean;
  /** TTS output sample rate (esp32 expects 24000 for opus frames). */
  sampleRate: 16000 | 24000;
  /** Text cleaner config (defaults to textCleaner.DEFAULT_CLEANER_CONFIG). */
  cleaner?: CleanerConfig;
}

export interface TtsPipelineHandle {
  /** Feed a text chunk (LLM streaming output). */
  feed: (text: string) => void;
  /** Flush remaining text, drain queues, send tts.stop. Resolves when done. */
  close: () => Promise<void>;
  /** Cancel immediately. Pending text is dropped. */
  abort: () => void;
}

/**
 * Split `text` on sentence boundaries. The first chunk is FIRST,
 * the last is LAST, anything in between is MIDDLE. Empty / whitespace-
 * only input returns an empty array.
 *
 * Boundary chars (both CJK and Latin):
 *   。 ！ ？  .  !  ?
 */
export function chunkSentence(text: string, _isFirst: boolean = true): SentenceChunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Capture delimiters with the split so we can mark sentence boundaries.
  // The pattern keeps the delimiter attached to the preceding fragment.
  const parts = trimmed.split(/(?<=[。！？.!?])/);
  const out: SentenceChunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]?.trim() ?? "";
    if (!seg) continue;
    let type: SentenceType;
    if (out.length === 0 && i === 0) {
      // The very first non-empty segment of the input is FIRST.
      // (The caller can pass _isFirst=false later to mark a continuation;
      // for the current single-pass design, we always treat the input
      // as a fresh turn.)
      type = i === parts.length - 1 ? "LAST" : "FIRST";
    } else {
      type = i === parts.length - 1 ? "LAST" : "MIDDLE";
    }
    out.push({ text: seg, type });
  }
  // Ensure exactly one LAST.
  if (out.length > 0) {
    out[out.length - 1] = { ...out[out.length - 1]!, type: "LAST" };
  }
  return out;
}

interface StartTtsPipelineArgs {
  ws: WebSocket;
  sessionId: string;
  session: SessionContext;
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
  cfg: TtsPipelineConfig;
  tts: TTSProvider;
  /** Reply text already sent via LLM message before the pipeline starts. */
  replyText: string;
  /** Called on error; pipeline still attempts tts.stop + markTtsEnded. */
  onError?: (err: unknown) => void;
}

/**
 * Start the 3-queue streaming TTS pipeline for one reply.
 *
 * The function returns a handle immediately. The actual work happens
 * in detached async loops (the two workers). The handle is the
 * caller's control surface.
 *
 * Note: `startTtsPipeline` does NOT send the initial tts.start /
 * sendLlmMessage — the caller is expected to do that synchronously
 * (mirroring the legacy path's "tts.start BEFORE sendLlmMessage"
 * ordering). The pipeline owns the rest of the lifecycle: tts.start
 * is sent here, sentence_start per chunk, opus frames, tts.stop
 * on close. markTtsEnded is called on close.
 */
export function startTtsPipeline(args: StartTtsPipelineArgs): TtsPipelineHandle {
  const { ws, sessionId, session, log, cfg, tts, replyText, onError } = args;

  if (!cfg.useStreamingTts) {
    // The opt-in gate: if a caller forgets to check the flag, the
    // pipeline refuses to start. This is a safety net on top of the
    // call-site `if (cfg.useStreamingTts)` branch.
    throw new Error("startTtsPipeline called with useStreamingTts=false");
  }

  const cleaner = cfg.cleaner ?? DEFAULT_CLEANER_CONFIG;
  const encoder = new OpusCodec(cfg.sampleRate, 1);
  const frameBytes = frameSizeBytes(cfg.sampleRate);

  // 3 queues:
  //   ttsTextQueue  : text chunks produced by the LLM (via .feed())
  //   ttsAudioQueue : PCM chunks produced by the TTS worker
  //
  // The "third queue" is implicit: ttsAudioWorker → ws.send. We keep
  // it as an async function instead of a real array for simplicity
  // (opus encoding is cheap, the pipeline doesn't need a backing
  // store for frames).
  const ttsTextQueue: string[] = [];
  const ttsAudioQueue: { pcm: Buffer; text: string; sampleRate: number; isFirst: boolean; isLast: boolean }[] = [];

  let ttsStopSent = false;
  let aborted = false;
  let closed = false;
  const lastTextRef: { value: string } = { value: replyText };

  // Resolvers / promise plumbing
  let closeResolve: (() => void) | null = null;
  const closedPromise: Promise<void> = new Promise((resolve) => {
    closeResolve = resolve;
  });

  // Transition into SPEAKING immediately (mirrors legacy path).
  // This is idempotent if the caller already transitioned.
  transitionTo(session, "SPEAKING");

  // Note: tts.start is sent by the CALLER before startTtsPipeline
  // returns. The xiaozhi protocol requires tts.start to come BEFORE
  // sendLlmMessage and BEFORE any opus frames; the call sites
  // (esp32ListenHandler.deliver, inbound.deliverLocalReply,
  // inbound.dispatchClientMessage) handle that ordering. We only
  // own the per-sentence opus frames and the final tts.stop.

  function sendStopOnce(): void {
    if (ttsStopSent) return;
    ttsStopSent = true;
    sendTtsStop(ws, sessionId);
  }

  function encodeAndEmit(pcm: Buffer, text: string): void {
    if (aborted || session.aborted) return;
    sendTtsSentenceStart(ws, sessionId, text);
    if (pcm.length === 0) return;

    // Slice into 60ms frames, encode each, send binary.
    let pending = pcm;
    const frames: Buffer[] = [];
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      try {
        frames.push(encoder.encode(frame));
      } catch (err) {
        log.warn(`xiaozhi: ${session.deviceId} opus encode failed: ${(err as Error).message}`);
      }
      pending = pending.subarray(frameBytes);
    }
    if (pending.length > 0) {
      // Tail pad
      const padded = Buffer.alloc(frameBytes);
      pending.copy(padded, 0, 0, Math.min(pending.length, frameBytes));
      try {
        frames.push(encoder.encode(padded));
      } catch (err) {
        log.warn(`xiaozhi: ${session.deviceId} opus encode (tail) failed: ${(err as Error).message}`);
      }
    }
    if (frames.length > 0) {
      sendTtsOpusFrames(ws, frames);
    }
  }

  // Worker 1: text → audio (synthesizes each chunkSentence emission)
  async function textWorker(): Promise<void> {
    try {
      for (;;) {
        if (aborted) return;
        if (session.aborted) {
          log.info(`xiaozhi: ${session.deviceId} text-worker aborted by session flag`);
          return;
        }
        const raw = ttsTextQueue.shift();
        if (raw === undefined) {
          if (closed) return;
          // No work, no close signal — yield to event loop briefly.
          await new Promise((r) => setImmediate(r));
          continue;
        }
        const cleaned = cleanForTTS(raw, cleaner);
        if (!cleaned) continue;
        lastTextRef.value = cleaned;
        const sentences = chunkSentence(cleaned);
        if (sentences.length === 0) continue;
        // Synthesize the joined sentence text as a single TTS call.
        const joinedText = sentences.map((s) => s.text).join(" ");
        // tts.start is sent by the caller before startTtsPipeline was
        // invoked (see esp32ListenHandler + inbound.ts opt-in branches).
        // We don't re-send it here — the protocol requires tts.start to
        // come BEFORE sendLlmMessage, not after, and the caller owns
        // that ordering.
        try {
          for await (const chunk of tts.synthesize(joinedText)) {
            if (aborted || session.aborted) return;
            if (chunk.pcm.length === 0) continue;
            ttsAudioQueue.push(chunk);
          }
        } catch (err) {
          log.error(`xiaozhi: ${session.deviceId} TTS synth failed: ${(err as Error).message}`);
          if (onError) onError(err);
          // Don't rethrow — the audio worker will still drain whatever
          // made it into the audio queue, and the close promise will
          // resolve so the deliver callback can finish.
        }
      }
    } catch (err) {
      log.error(`xiaozhi: ${session.deviceId} text-worker crashed: ${(err as Error).message}`);
      if (onError) onError(err);
    }
  }

  // Worker 2: audio → ws
  async function audioWorker(): Promise<void> {
    try {
      for (;;) {
        if (aborted) return;
        if (session.aborted) return;
        const chunk = ttsAudioQueue.shift();
        if (chunk === undefined) {
          // No audio in queue. Are we done?
          if (closed && ttsTextQueue.length === 0) {
            // Both queues drained, the text worker is also exiting —
            // emit tts.stop and resolve the close promise.
            sendStopOnce();
            markTtsEnded(session, lastTextRef.value, log);
            return;
          }
          await new Promise((r) => setImmediate(r));
          continue;
        }
        encodeAndEmit(chunk.pcm, chunk.text);
      }
    } catch (err) {
      log.error(`xiaozhi: ${session.deviceId} audio-worker crashed: ${(err as Error).message}`);
      if (onError) onError(err);
    }
  }

  // Kick off both workers.
  const textWorkerP = textWorker();
  const audioWorkerP = audioWorker();

  // When both workers exit, resolve the close promise.
  Promise.allSettled([textWorkerP, audioWorkerP]).then(() => {
    // Best-effort: ensure tts.stop + markTtsEnded happened even on error.
    if (!ttsStopSent) {
      try {
        sendStopOnce();
      } catch { /* ignore */ }
    }
    markTtsEnded(session, lastTextRef.value, log);
    if (closeResolve) closeResolve();
  });

  return {
    feed(text: string) {
      if (aborted || closed) return;
      if (!text) return;
      ttsTextQueue.push(text);
    },
    async close() {
      if (aborted) return;
      closed = true;
      await closedPromise;
    },
    abort() {
      aborted = true;
      closed = true;
      // Best-effort: still send tts.stop so the device exits SPEAKING.
      try {
        sendStopOnce();
      } catch { /* ignore */ }
      markTtsEnded(session, lastTextRef.value, log);
      if (closeResolve) closeResolve();
    },
  };
}

// Re-export so consumers can grab the cleaner config in one place.
export { cleanForTTS, DEFAULT_CLEANER_CONFIG, type CleanerConfig } from "./textCleaner.js";

// Also re-export the LLM-message sender so callers have a single import
// surface (some sites don't use outbound.ts directly).
export { sendLlmMessage };
