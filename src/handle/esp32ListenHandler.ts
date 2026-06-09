/**
 * esp32 Listen handler — drains Opus audio buffer → PCM → ASR → dispatch.
 *
 * M3.4c: full path for esp32 mic audio:
 *   1. esp32 sends `listen state=start` + binary opus frames (LISTENING)
 *   2. esp32 sends `listen state=stop` (THINKING)
 *   3. We drain audioBuffer, opus-decode all frames → PCM int16 @ 16kHz
 *   4. asr.transcribe(pcm) → recognized text
 *   5. Send STT echo to esp32
 *   6. dispatchInboundDirectDmWithRuntime → agent loop → TTS pipeline
 *   7. transitionTo(IDLE) when agent delivers
 *
 * Mirrors V2 bridge server.py _handle_listen + _process_audio + ASR call.
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  dispatchInboundDirectDmWithRuntime,
} from "openclaw/plugin-sdk/channel-inbound";
import type { XiaozhiAccount } from "../config.js";
import { getASRProvider, ASRError } from "../asr/index.js";
import { getTTSProvider, TTSError } from "../tts/index.js";
import { sendSttMessage, sendLlmMessage, sendTtsAudio } from "../outbound.js";
import { OpusCodec, frameSizeBytes } from "../audio.js";
import {
  drainAudioBuffer,
  isInPostTtsGrace,
  transitionTo,
  type SessionContext,
} from "../session.js";
import { buildDirectDmRuntime, getXiaozhiRuntime, getXiaozhiConfig, getXiaozhiAsrConfig, getXiaozhiTtsConfig } from "../api.js";

export interface ListenStopCtx {
  account: XiaozhiAccount;
  deviceId: string;
  sessionId: string;
  ws: WebSocket;
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * Handle Listen(stop): drain audio, ASR, dispatch.
 *
 * Returns when the agent has delivered (text + audio).
 */
export async function handleListenStop(
  ctx: ListenStopCtx,
  session: SessionContext,
): Promise<void> {
  const { log } = ctx;

  // v0.3.6: post-TTS echo suppression. esp32's mic re-captures the
  // TTS audio we just sent (no AEC on the device side). Without
  // this guard, ASR returns garbled echo, the agent loop is
  // dispatched, and the user hears the same reply twice.
  if (isInPostTtsGrace(session)) {
    log.info(
      `xiaozhi: ${ctx.deviceId} listen stop suppressed — ` +
      `inside post-TTS grace window (last reply was "${session.lastTtsText?.slice(0, 40)}")`,
    );
    drainAudioBuffer(session);
    transitionTo(session, "IDLE");
    return;
  }

  // 1. Drain audio buffer
  const opusFrames = drainAudioBuffer(session);
  if (opusFrames.length === 0) {
    log.warn(`xiaozhi: ${ctx.deviceId} listen stop with empty audio buffer`);
    transitionTo(session, "IDLE");
    return;
  }
  log.info(`xiaozhi: ${ctx.deviceId} listen stop: ${opusFrames.length} opus frames`);

  // 2. Opus decode → PCM int16 16kHz mono
  const decoderCodec = session.codec.sampleRate === 16000
    ? session.codec
    : new OpusCodec(16000, 1);
  const pcm = decodeOpusFrames(opusFrames, decoderCodec);
  log.info(
    `xiaozhi: ${ctx.deviceId} pcm: ${(pcm.length / 1024).toFixed(1)} KiB ` +
    `(${(pcm.length / 2 / 16).toFixed(2)}s @ 16kHz)`,
  );

  // 3. ASR transcribe
  const asr = getASRProvider(getXiaozhiAsrConfig());
  log.info(`xiaozhi: ${ctx.deviceId} asr=${asr.name} transcribing...`);
  const t0 = Date.now();
  let asrResult;
  try {
    asrResult = await asr.transcribe(pcm);
  } catch (err) {
    const e = err as ASRError;
    log.error(`xiaozhi: ${ctx.deviceId} ASR failed:`, e.message);
    transitionTo(session, "IDLE");
    return;
  }
  const text = asrResult.text.trim();
  const asrMs = Date.now() - t0;
  log.info(
    `xiaozhi: ${ctx.deviceId} asr ${asrMs}ms → "${text}" ` +
    `(rtf=${asrResult.elapsedMs ? (asrResult.elapsedMs / (pcm.length / 2 / 16)).toFixed(2) : "n/a"})`,
  );
  if (text.length === 0) {
    log.warn(`xiaozhi: ${ctx.deviceId} ASR returned empty text, skipping dispatch`);
    transitionTo(session, "IDLE");
    return;
  }

  // 4. Dispatch to openclaw agent (which will also call TTS in deliver)
  transitionTo(session, "THINKING");
  const runtime = getXiaozhiRuntime();
  if (!runtime) {
    log.error(`xiaozhi: runtime not initialized, dropping ASR text`);
    transitionTo(session, "IDLE");
    return;
  }
  const dmRuntime = buildDirectDmRuntime(runtime) as never;

  // Send STT echo so esp32 displays the recognized text first
  sendSttMessage(ctx.ws, ctx.sessionId, text);

  // Pre-build TTS provider reference for the deliver callback
  const tts = (() => {
    try { return getTTSProvider(getXiaozhiTtsConfig()); } catch (e) {
      log.warn(`xiaozhi: TTS not configured (${(e as Error).message}), text-only delivery`);
      return null;
    }
  })();
  if (tts) log.info(`xiaozhi: ${ctx.deviceId} tts=${tts.name}`);

  // Encoder for esp32 TTS audio (24kHz opus, separate from 16kHz decoder)
  const ttsEncoder = new OpusCodec(24000, 1);

  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg: getXiaozhiConfig() as never,
      runtime: dmRuntime,
      channel: "xiaozhi",
      channelLabel: "Xiaozhi Device",
      accountId: ctx.account.accountId,
      peer: { kind: "direct", id: ctx.deviceId },
      senderId: ctx.deviceId,
      senderAddress: `xiaozhi:${ctx.deviceId}`,
      recipientAddress: `xiaozhi:${ctx.deviceId}`,
      conversationLabel: ctx.deviceId,
      rawBody: text,
      messageId: randomUUID(),
      timestamp: Date.now(),
      deliver: async (payload) => {
        const replyText = String((payload as { text?: string })?.text ?? "").trim();
        if (!replyText) {
          log.debug(`xiaozhi: ${ctx.deviceId} deliver with empty text, skipping`);
          return;
        }

        // 1. Send LLM message (text + emotion) for esp32 display
        sendLlmMessage(ctx.ws, ctx.sessionId, undefined, replyText);
        log.info(
          `xiaozhi: ${ctx.deviceId} llm reply: "${replyText.slice(0, 80)}${replyText.length > 80 ? "…" : ""}"`,
        );

        // 2. TTS pipeline (M3.4d): stream reply text → PCM chunks → opus frames
        if (!tts) return;
        transitionTo(session, "SPEAKING");
        const ttsStart = Date.now();
        try {
          const opusFrames = await streamTtsToOpusFrames(tts, replyText, ttsEncoder, log);
          const ttsMs = Date.now() - ttsStart;
          log.info(
            `xiaozhi: ${ctx.deviceId} tts ${ttsMs}ms → ${opusFrames.length} opus frames ` +
            `(${(replyText.length / (ttsMs / 1000)).toFixed(0)} chars/sec)`,
          );
          sendTtsAudio(ctx.ws, ctx.sessionId, replyText, opusFrames);
        } catch (err) {
          const e = err as TTSError;
          log.error(`xiaozhi: ${ctx.deviceId} TTS failed:`, e.message);
          // TTS failed but text was already delivered — esp32 will still see
          // the LLM message on its display. Device just won't play audio.
        } finally {
          transitionTo(session, "IDLE");
        }
      },
      onRecordError: (err) => log.error(`xiaozhi: record error:`, err),
      onDispatchError: (err) => log.error(`xiaozhi: dispatch error:`, err),
    });
  } catch (err) {
    log.error(`xiaozhi: dispatch failed for ${ctx.deviceId}:`, (err as Error).message);
    sendLlmMessage(ctx.ws, ctx.sessionId, undefined, `Error: ${(err as Error).message}`);
    transitionTo(session, "IDLE");
  }
}

/** Decode an array of opus frames into one PCM int16 buffer. */
function decodeOpusFrames(opusFrames: Buffer[], codec: OpusCodec): Buffer {
  const out: Buffer[] = [];
  for (const frame of opusFrames) {
    out.push(codec.decode(frame));
  }
  return Buffer.concat(out);
}

/**
 * M3.4d: TTS pipeline — synthesize text → PCM chunks → opus frames.
 *
 * Buffers PCM until we have at least one full 60ms frame, then opus-encodes
 * and emits. The TTS provider yields chunks continuously; we accumulate to
 * 60ms boundaries to keep the esp32 frame count deterministic.
 */
export async function streamTtsToOpusFrames(
  tts: ReturnType<typeof getTTSProvider>,
  text: string,
  encoder: OpusCodec,
  log: ListenStopCtx["log"],
): Promise<Buffer[]> {
  const frameBytes = frameSizeBytes(24000);
  let pending: Buffer = Buffer.alloc(0);
  const opusFrames: Buffer[] = [];
  let firstChunkSeen = false;

  for await (const chunk of tts.synthesize(text)) {
    if (chunk.pcm.length === 0) continue;
    firstChunkSeen = true;
    pending = Buffer.concat([pending, chunk.pcm]);

    // Emit complete 60ms frames
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      try {
        opusFrames.push(encoder.encode(frame));
      } catch (err) {
        log.warn(`xiaozhi: opus encode failed: ${(err as Error).message}`);
      }
    }
  }

  // Pad the last partial frame to 60ms with silence
  if (firstChunkSeen && pending.length > 0) {
    const padded = Buffer.alloc(frameBytes);
    pending.copy(padded, 0, 0, Math.min(pending.length, frameBytes));
    try {
      opusFrames.push(encoder.encode(padded));
    } catch (err) {
      log.warn(`xiaozhi: opus encode (tail) failed: ${(err as Error).message}`);
    }
  }

  return opusFrames;
}
