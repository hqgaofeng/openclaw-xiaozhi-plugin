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
import { sendSttMessage, sendLlmMessage, sendTtsStart, sendTtsSentenceStart, sendTtsOpusFrames, sendTtsStop } from "../outbound.js";
import { OpusCodec, frameSizeBytes } from "../audio.js";
import {
  drainAudioBuffer,
  isInPostTtsGrace,
  markTtsEnded,
  transitionTo,
  type SessionContext,
} from "../session.js";
import { buildDirectDmRuntime, getXiaozhiRuntime, getXiaozhiConfig, getXiaozhiAsrConfig, getXiaozhiTtsConfig, getXiaozhiChannelConfig, getMetricsEnabled } from "../api.js";
// v0.4.0-rc2 (batch 2): metrics helpers. The cfg-derived
// `getMetricsEnabled()` flag is read on every call site; when false
// (the default) the helpers are no-ops AND the `if (getMetricsEnabled())`
// guards in this file elide the labels-object allocation entirely.
import { incCounter, observe } from "../metrics.js";
// v0.4.0-rc1 (batch 1): streaming TTS pipeline + text cleaner. The
// imports below are only used when cfg.useStreamingTts === true;
// when the flag is false (default), the legacy streamTtsToOpusFrames
// path runs untouched and the new modules are never instantiated.
// We import the symbols unconditionally because TypeScript needs the
// type information for the conditional block; the runtime cost is
// zero (top-level imports of pure modules are tree-shakeable).
import { startTtsPipeline } from "../ttsPipeline.js";

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

  // M6 fix: assert state === LISTENING here. The esp32 firmware
  // is supposed to send listen.stop only after a matching
  // listen.start, but in practice we sometimes see listen.stop
  // arrive out of order (e.g. right after a tts.stop) — the
  // previous code happily drained a (probably empty) buffer and
  // went on, masking state-machine bugs. Log loudly so we catch
  // them in tests.
  const stateOnStop = session.state;
  if (stateOnStop !== "LISTENING") {
    log.warn(
      `xiaozhi: ${ctx.deviceId} listen stop arrived in unexpected state=${stateOnStop} ` +
      `(frames=${opusFrames.length}, lastActivity=${
        Date.now() - session.lastActivityAt
      }ms ago, lastTts="${session.lastTtsText?.slice(0, 40) ?? ""}")`,
    );
    // Don't bail — the device may be coming out of a tts stop and
    // the user might still be talking. Just don't try to dispatch
    // an empty / spurious buffer downstream.
    if (opusFrames.length === 0) {
      transitionTo(session, "IDLE");
      return;
    }
  }

  if (opusFrames.length === 0) {
    log.warn(`xiaozhi: ${ctx.deviceId} listen stop with empty audio buffer`);
    transitionTo(session, "IDLE");
    return;
  }
  log.info(`xiaozhi: ${ctx.deviceId} listen stop: ${opusFrames.length} opus frames (state was ${stateOnStop})`);

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
    // v0.4.0-rc2 (batch 2): metric — failed ASR transcribe.
    if (getMetricsEnabled()) {
      incCounter("xiaozhi_asr_transcribe_total", { device: ctx.deviceId, status: "error" });
    }
    transitionTo(session, "IDLE");
    return;
  }
  const text = asrResult.text.trim();
  const asrMs = Date.now() - t0;
  // v0.4.0-rc2 (batch 2): metrics — successful ASR transcribe + duration.
  if (getMetricsEnabled()) {
    incCounter("xiaozhi_asr_transcribe_total", { device: ctx.deviceId, status: "ok" });
    observe("xiaozhi_asr_duration_ms", asrMs, { device: ctx.deviceId, provider: asr.name });
  }
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

        // v0.4.0-rc2 (batch 2): LLM duration metric — measure wall
        // time from deliver entry until TTS start (the "agent
        // thought" wall time, which is what we care about for
        // monitoring tail-latency on the LLM leg).
        const llmStart = Date.now();

        // 1. Transition to SPEAKING FIRST so any concurrent mic frames
        //    arriving during the TTS pipeline get dropped (they're speaker
        //    echo, not user speech).
        transitionTo(session, "SPEAKING");

        // 2. Send tts.start BEFORE sendLlmMessage so the esp32 display
        //    knows we're entering a TTS turn. esp32 firmware validates
        //    the tts.state sequence and ignores LLM messages that arrive
        //    before tts.start.
        sendTtsStart(ctx.ws, ctx.sessionId);

        // 3. Send LLM message (text + emotion) for esp32 display
        sendLlmMessage(ctx.ws, ctx.sessionId, undefined, replyText);
        log.info(
          `xiaozhi: ${ctx.deviceId} llm reply: "${replyText.slice(0, 80)}${replyText.length > 80 ? "…" : ""}"`,
        );
        // v0.4.0-rc2 (batch 2): record the LLM wall time. The
        // openclaw deliver callback already includes the LLM
        // roundtrip; we measure from the deliver entry to the
        // tts.start emission as a proxy for "agent thought time".
        if (getMetricsEnabled()) {
          observe("xiaozhi_llm_duration_ms", Date.now() - llmStart, { device: ctx.deviceId });
        }

        // 4. TTS pipeline: stream reply text → PCM chunks → opus frames
        //    Then send sentence_start (with text), frames, tts.stop.
        //    The markTtsEnded() call in finally activates the post-TTS
        //    echo grace window even if the TTS encoding throws.
        if (!tts) {
          // No TTS provider — still need to send tts.stop so the device
          // exits SPEAKING state. markTtsEnded so echo suppression works.
          sendTtsStop(ctx.ws, ctx.sessionId);
          markTtsEnded(session, replyText, log);
          return;
        }

        // v0.4.0-rc1 (batch 1): opt-in streaming TTS pipeline. When
        // `useStreamingTts` is true in the xiaozhi channel config, we
        // run the new 3-queue pipeline. When false (default), we
        // continue to use the legacy `streamTtsToOpusFrames` helper
        // with zero behavioural change vs v0.3.0.
        const channelCfg = getXiaozhiChannelConfig() as { useStreamingTts?: boolean } | undefined;
        if (channelCfg?.useStreamingTts === true) {
          const ttsPipelineStart = Date.now();
          try {
            const handle = startTtsPipeline({
              ws: ctx.ws,
              sessionId: ctx.sessionId,
              session,
              log,
              cfg: { useStreamingTts: true, sampleRate: 24000 },
              tts,
              replyText,
              onError: (err) => log.error(`xiaozhi: ${ctx.deviceId} streaming tts error:`, (err as Error).message),
            });
            // For the opt-in path we have a single non-streaming reply
            // text from the LLM (no token-by-token delivery from the
            // openclaw runtime yet). Feed it as one chunk and close.
            handle.feed(replyText);
            await handle.close();
            const ttsMs = Date.now() - ttsPipelineStart;
            // v0.4.0-rc2 (batch 2): TTS duration metric (streaming path).
            if (getMetricsEnabled()) {
              observe("xiaozhi_tts_duration_ms", ttsMs, { device: ctx.deviceId, mode: "streaming", status: "ok" });
            }
            log.info(
              `xiaozhi: ${ctx.deviceId} streaming-tts ${ttsMs}ms (reply=${replyText.length} chars)`,
            );
          } catch (err) {
            log.error(`xiaozhi: ${ctx.deviceId} streaming tts failed:`, (err as Error).message);
            if (getMetricsEnabled()) {
              incCounter("xiaozhi_tts_failure_total", { device: ctx.deviceId, mode: "streaming" });
            }
            try { sendTtsStop(ctx.ws, ctx.sessionId); } catch { /* ignore */ }
          } finally {
            markTtsEnded(session, replyText, log);
          }
          return;
        }

        const ttsStart = Date.now();
        let opusFrames: Buffer[] = [];
        try {
          opusFrames = await streamTtsToOpusFrames(tts, replyText, ttsEncoder, log, session);
          const ttsMs = Date.now() - ttsStart;
          // v0.4.0-rc2 (batch 2): TTS duration metric (legacy path).
          if (getMetricsEnabled()) {
            observe("xiaozhi_tts_duration_ms", ttsMs, { device: ctx.deviceId, mode: "legacy", status: "ok" });
          }
          log.info(
            `xiaozhi: ${ctx.deviceId} tts ${ttsMs}ms → ${opusFrames.length} opus frames ` +
            `(${(replyText.length / (ttsMs / 1000)).toFixed(0)} chars/sec)`,
          );
          sendTtsSentenceStart(ctx.ws, ctx.sessionId, replyText);
          sendTtsOpusFrames(ctx.ws, opusFrames);
          sendTtsStop(ctx.ws, ctx.sessionId);
        } catch (err) {
          const e = err as TTSError;
          if (getMetricsEnabled()) {
            incCounter("xiaozhi_tts_failure_total", { device: ctx.deviceId, mode: "legacy" });
          }
          log.error(`xiaozhi: ${ctx.deviceId} TTS failed:`, e.message);
          // Bug 1 fix: still send tts.stop so device doesn't stay in
          // SPEAKING forever, and markTtsEnded so the post-TTS grace
          // window activates (otherwise the next VAD stop will treat
          // the silence as a new turn and possibly echo-trigger).
          try {
            sendTtsStop(ctx.ws, ctx.sessionId);
          } catch { /* ignore */ }
        } finally {
          markTtsEnded(session, replyText, log);
        }
      },
      onRecordError: (err) => log.error(`xiaozhi: record error:`, err),
      onDispatchError: (err) => log.error(`xiaozhi: dispatch error:`, err),
    });
    // v0.4.0-rc2 (batch 2): dispatch succeeded (deliver was called
    // and the agent loop returned). Increment the ok counter here so
    // we don't double-count on the throw path.
    if (getMetricsEnabled()) {
      incCounter("xiaozhi_dispatch_total", { device: ctx.deviceId, status: "ok" });
    }
  } catch (err) {
    log.error(`xiaozhi: dispatch failed for ${ctx.deviceId}:`, (err as Error).message);
    if (getMetricsEnabled()) {
      incCounter("xiaozhi_dispatch_total", { device: ctx.deviceId, status: "error" });
    }
    sendLlmMessage(ctx.ws, ctx.sessionId, undefined, `Error: ${(err as Error).message}`);
    transitionTo(session, "IDLE");
  } finally {
    // Bug 9 fix: the dispatch path (line 142) transitions to THINKING
    // and the deliver callback transitions to SPEAKING + back to IDLE
    // for grace-window purposes — but neither of those is the same
    // as the canonical "session is fully idle, ready for the next
    // user turn" transition. Without this finally block, the session
    // stays in SPEAKING (or THINKING) forever after a successful
    // LLM+TTS exchange, and the next listen.start is rejected with
    // "session in SPEAKING" — exactly the "answered the weather
    // question, then no further replies" bug.
    //
    // We use finally so the transition happens whether deliver
    // succeeded, threw, or was never called.
    if (session.state === "SPEAKING" || session.state === "THINKING") {
      transitionTo(session, "IDLE");
    }
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
 *
 * v0.3.7 (Bug 3 fix): if session.aborted is set (by an in-flight abort
 * from the device), the loop breaks early so late TTS audio doesn't
 * reach the device after the user interrupted.
 */
export async function streamTtsToOpusFrames(
  tts: ReturnType<typeof getTTSProvider>,
  text: string,
  encoder: OpusCodec,
  log: ListenStopCtx["log"],
  session: SessionContext,
): Promise<Buffer[]> {
  const frameBytes = frameSizeBytes(24000);
  let pending: Buffer = Buffer.alloc(0);
  const opusFrames: Buffer[] = [];
  let firstChunkSeen = false;
  let aborted = false;

  for await (const chunk of tts.synthesize(text)) {
    // Bug 3 fix: bail out of the loop on abort. The deliver callback's
    // finally block (markTtsEnded + tts.stop) still runs, but we stop
    // synthesizing new audio and stop sending frames.
    if (session.aborted) {
      log.info(
        `xiaozhi: ${session.deviceId} TTS stream aborted mid-synthesis ` +
        `(${opusFrames.length} frames emitted before abort)`,
      );
      aborted = true;
      break;
    }
    if (chunk.pcm.length === 0) continue;
    firstChunkSeen = true;
    pending = Buffer.concat([pending, chunk.pcm]);

    // Emit complete 60ms frames
    while (pending.length >= frameBytes) {
      // Re-check abort before each encode (the synthesize iterator
      // yields chunks asynchronously, so a device abort could land
      // between two encode calls).
      if (session.aborted) {
        aborted = true;
        break;
      }
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      try {
        opusFrames.push(encoder.encode(frame));
      } catch (err) {
        log.warn(`xiaozhi: opus encode failed: ${(err as Error).message}`);
      }
    }
    if (aborted) break;
  }

  // Pad the last partial frame to 60ms with silence
  if (!aborted && firstChunkSeen && pending.length > 0) {
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
