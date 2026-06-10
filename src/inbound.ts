/**
 * ChannelMessagingAdapter — esp32 → openclaw inbound dispatch.
 *
 * Translates xiaozhi protocol messages to openclaw MsgContext and
 * dispatches them to the agent loop via ctx.channelRuntime.dispatch.
 *
 * 4 inbound message types:
 *   1. Hello    → create session (key = `xiaozhi-${deviceId}`)
 *   2. Listen   → write to audio queue (ASR auto-detect)
 *   3. Abort    → cancel current turn
 *   4. MCP      → tool router (M3.7)
 *
 * @see docs/sdk-research-v3.md §3.1 for the 1:1 translation table.
 */

import type { ChannelMessagingAdapter, ChannelAgentTool } from "openclaw/plugin-sdk/channel-runtime";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { XiaozhiAccount } from "./config.js";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { buildDirectDmRuntime, getXiaozhiRuntime, getXiaozhiConfig, getXiaozhiTtsConfig, getXiaozhiChannelConfig } from "./api.js";
import { sendSttMessage, sendLlmMessage, sendTtsStart, sendTtsSentenceStart, sendTtsOpusFrames, sendTtsStop, sendTtsAudio } from "./outbound.js";
import { getTTSProvider } from "./tts/index.js";
import { OpusCodec } from "./audio.js";
// M3.7.3: borrow the same TTS→opus streaming helper that handleListenStop
// uses for the Listen(stop) path. The detect path was M3.3b-stubbed to
// text-only and is now being upgraded to match.
import { streamTtsToOpusFrames } from "./handle/esp32ListenHandler.js";
// v0.4.0-rc1 (batch 1): streaming TTS pipeline opt-in. Used only when
// `channels.xiaozhi.useStreamingTts === true`; when false (default),
// the legacy `streamTtsToOpusFrames` path is unchanged.
import { startTtsPipeline } from "./ttsPipeline.js";

// v0.3.5: helper for wake-word short-circuit (mirrors
//   xiaozhi-esp32-server core/utils/util.py:remove_punctuation_and_length).
//   We use a minimal version: strip Chinese + ASCII punctuation and
//   collapse whitespace. We only need the filtered text for set
//   membership (wakeup_words check), not for length tracking.
function stripPunctuation(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, "")
    .replace(
      /[\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u3000-\u303F!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？、；：""''「」『』《》（）【】]/g,
      "",
    );
}

// Exported under a different name for unit testing only — internal
// use stays unexported.
export const stripPunctuationForTest = stripPunctuation;
import {
  parseClientMessage,
  serializeServerMessage,
  type ServerHello,
  type ClientMessage,
} from "./protocol.js";
import {
  createSessionContext,
  appendAudioFrame,
  cleanupSession,
  drainAudioBuffer,
  transitionTo,
  markTtsEnded,
  isInPostTtsGrace,
  type SessionContext,
} from "./session.js";
import type { SessionStore } from "./gateway.js";
import { resolveMcpResponse } from "./mcp/outbound.js";
import { handleEsp32McpRequest } from "./mcp/inbound.js";
import { registerEsp32Tools, unregisterEsp32Tools } from "./mcp/registry.js";
import type { McpTool } from "./mcp/protocol.js";
import { handleListenStop } from "./handle/esp32ListenHandler.js";
import { startVadWatcher, bufferHasSpeech } from "./vad.js";

export interface Esp32ConnectionCtx {
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
  sessionStore: SessionStore;
  /**
   * M3.7: invoked when esp32 reports its tool list (MCP tools/list
   * response). Caller pushes the returned ChannelAgentTool[] into the
   * openclaw agentTools list. Optional — if absent, the tools are
   * logged but not exposed to the LLM.
   */
  onEsp32ToolsList?: (
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  ) => Promise<ChannelAgentTool[]>;
}

export function createXiaozhiMessagingAdapter(): ChannelMessagingAdapter {
  return {
    targetPrefixes: ["xiaozhi:"],
    deriveLegacySessionChatType: () => "direct",
    // TODO(M3.4): implement normalizeTarget when full plugin dispatch path is wired
  } as ChannelMessagingAdapter;
}

/**
 * Handle a new esp32 WebSocket connection.
 *
 * Loop:
 *   1. Wait for first message (must be Hello) → reply ServerHello
 *   2. Subsequent messages:
 *      - Listen(start) + binary → Opus → audio buffer (state = LISTENING)
 *      - Listen(stop)         → drain audio, end turn
 *      - Listen(detect) + text → dispatch text directly
 *      - Abort                → cancel current turn
 *      - MCP (response)       → resolve pendingMcpCall
 *      - MCP (request)        → forward to M3.7
 *   3. On close → cleanupSession
 */
export async function handleEsp32Connection(ctx: Esp32ConnectionCtx): Promise<void> {
  const { ws, deviceId, sessionId, log } = ctx;
  const codec = new OpusCodec(16000);
  const session = createSessionContext(deviceId, sessionId, codec);
  ctx.sessionStore.register(deviceId, session);

  // M3.7.3: install a logger that names this session (so we can grep
  // session-scoped log lines when chasing per-device bugs)
  // (kept for future per-session log wiring; intentionally unused for now
  // so TS noUnusedLocals doesn't fire — we'll thread it through once we
  // know which frame drop path is responsible)
  void deviceId;

  // 1. Install permanent listeners + queue (M3.7.3: same queue the main
  //    loop consumes, so even the hello handshake can use it without
  //    falling back to a cleanup-and-rebind dance).
  const incomingQueue: WsEvent[] = [];
  let incomingResolve: (() => void) | null = null;
  let incomingClosed = false;

  const onAnyMessage = (data: unknown, isBinary: boolean) => {
    const event: WsEvent = isBinary
      ? { kind: "binary", data: toBuffer(data) }
      : { kind: "text", data: typeof data === "string" ? data : toBuffer(data).toString("utf8") };
    incomingQueue.push(event);
    if (incomingResolve) {
      const r = incomingResolve;
      incomingResolve = null;
      r();
    }
  };
  const onClose = () => {
    incomingClosed = true;
    if (incomingResolve) {
      const r = incomingResolve;
      incomingResolve = null;
      r();
    }
  };
  const onError = (err: Error) => {
    log.warn(`xiaozhi: ws error: ${err.message}`);
    incomingClosed = true;
    if (incomingResolve) {
      const r = incomingResolve;
      incomingResolve = null;
      r();
    }
  };
  ws.on("message", onAnyMessage as never);
  ws.on("close", onClose);
  ws.on("error", onError);

  // 1a. Wait for Hello (consume from the same queue so we don't lose
  //     anything arriving in the gap before main loop starts)
  const awaitNext = (): Promise<void> =>
    incomingQueue.length > 0 || incomingClosed
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          incomingResolve = resolve;
        });

  const waitForJsonMessage = async (
    expectedType: string,
  ): Promise<ClientMessage | null> => {
    while (!incomingClosed) {
      while (incomingQueue.length > 0) {
        const event = incomingQueue.shift()!;
        if (event.kind !== "text") {
          log.warn(`xiaozhi: expected JSON ${expectedType}, got binary`);
          continue;
        }
        const msg = parseClientMessage(asTextData(event));
        if (msg.type !== expectedType) {
          log.warn(`xiaozhi: expected ${expectedType}, got ${msg.type}`);
          continue;
        }
        return msg;
      }
      if (incomingClosed) return null;
      await awaitNext();
    }
    return null;
  };

  const helloMsg = await waitForJsonMessage("hello");
  if (!helloMsg) {
    log.warn(`xiaozhi: ${deviceId} disconnected before Hello`);
    // Detach listeners before bailing
    ws.off("message", onAnyMessage as never);
    ws.off("close", onClose);
    ws.off("error", onError);
    return;
  }

  // 2. Reply with ServerHello (echo client's audio_params so esp32 accepts
  //    the negotiated format; V2 bridge also echoed 1:1, see
  //    bridge/server.py:_handle_hello). esp32 firmware validates the
  //    sample_rate match and disconnects on mismatch (we hit this on the
  //    first real-device test — 30ms disconnect, 1008 close on mismatch).
  const clientAudioParams = (helloMsg as { audio_params?: { sample_rate?: number; channels?: number; frame_duration?: number; format?: string } }).audio_params
    ?? { format: "opus" as const, sample_rate: 16000, channels: 1, frame_duration: 60 };
  // M3.7.3: persist audio_params on the session so downstream code can
  // build a matching Opus decoder (was being read off a non-existent
  // field before — surfaced as 'sample_rate=?' in listen-start log).
  (session as { audioSampleRate?: number }).audioSampleRate = clientAudioParams.sample_rate ?? 16000;
  (session as { audioChannels?: number }).audioChannels = clientAudioParams.channels ?? 1;
  (session as { audioFrameDurationMs?: number }).audioFrameDurationMs = clientAudioParams.frame_duration ?? 60;
  (session as { audioFormat?: string }).audioFormat = clientAudioParams.format ?? "opus";
  // Bug 8 fix: the serverHello's audio_params.sample_rate is what the
  // esp32 firmware tags on every incoming audio packet as the "server
  // sample rate". If we echo back the mic capture rate (16000) but
  // the device's hardware output is 24kHz, the audio service resamples
  // every TTS frame, producing audible discontinuities ("断断续续").
  // The correct value is the device's TTS output rate (24kHz) — what
  // we actually encode TTS frames at. Frame duration + channels come
  // from the client (they're device-side constraints).
  const serverHello = {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: "opus" as const,
      // Always claim 24kHz as the server sample rate, regardless of
      // what the client said. Our OpusCodec encoder is fixed at 24kHz
      // (see streamTtsToOpusFrames / frameSizeBytes(24000)). 16kHz or
      // 8kHz clients can still talk to us — we just resample internally
      // if needed.
      sample_rate: 24000 as const,
      channels: clientAudioParams.channels ?? 1,
      frame_duration: clientAudioParams.frame_duration ?? 60,
    },
  } as ServerHello;
  ws.send(serializeServerMessage(serverHello));
  log.info(
    `xiaozhi: ${deviceId} hello acked, session=${sessionId}, ` +
    `audio_in=${clientAudioParams.sample_rate ?? 16000}Hz/${clientAudioParams.channels ?? 1}ch ` +
    `audio_out=24000Hz/${clientAudioParams.channels ?? 1}ch/` +
    `${clientAudioParams.frame_duration ?? 60}ms`,
  );

  // 3. Message loop — M3.7.3 rewrite: replace per-event cleanup-and-rebind
  //    with a permanent listener + bounded queue. The previous design lost
  //    messages when the cleanup→rebind gap coincided with a fast-arriving
  //    frame (esp32 pushes 35 wake-word opus frames in ~232ms, so any
  //    synchronous gap between off() and on() can drop the trailing
  //    Listen(detect) text — which is what we observed on the prod
  //    board: 0 plugin log lines for the detect text after the wake-word
  //    opus burst).
  //
  //    The fix mirrors the official xiaozhi-esp32-server pattern
  //    (core/connection.py:335 _route_message): a single OnData callback
  //    that synchronously queues each message, and a consumer loop that
  //    awaits the queue. No cleanup-and-rebind, no lost messages.
  while (!incomingClosed) {
    while (incomingQueue.length === 0 && !incomingClosed) {
      await awaitNext();
    }
    if (incomingClosed) break;
    const event = incomingQueue.shift()!;

    if (event.kind === "text") {
      try {
        const msg = parseClientMessage(asTextData(event));
        await dispatchClientMessage(ctx, session, msg, log);
      } catch (err) {
        console.error("BAD MSG", deviceId, err); log.warn(`xiaozhi: bad message from ${deviceId}:`, (err as Error)?.stack ?? (err as Error)?.message ?? String(err));
      }
    } else if (event.kind === "binary") {
      // M3.7.3: align with xiaozhi-esp32-server (core/connection.py:355
      // _route_message) which accepts audio bytes regardless of session
      // state — esp32 firmware sends 35 wake-word opus frames BEFORE
      // SetListeningMode/SetDeviceState(kDeviceStateListening), and
      // listening-mode text (ListenMessage detect/start/stop) is
      // interleaved between frame bursts. The previous
      // state==='LISTENING' guard caused 100% frame drop on the
      // first real-device test.
      //
      // M3.7.3.1: but in SPEAKING/THINKING states, the device is
      // playing TTS audio (or agent is thinking) — any mic frames we
      // receive are almost certainly the speaker's audio being
      // re-captured by the mic. Without AEC on the device side, this
      // creates an infinite loop: plugin pushes TTS audio, device
      // plays it, device's mic captures it, device pushes it back to
      // us, we ASR-transcribe it (often returning garbage/empty), we
      // send another listen.start, the device pushes more mic frames…
      // The fix is to drop mic input in any non-LISTENING state except
      // the IDLE→LISTENING auto-promotion edge case below.
      if (session.state === "SPEAKING" || session.state === "THINKING") {
        // Drop silently — this is echo of our own TTS, not user speech.
        return;
      }
      // M5 fix: detect wake-word-tail frame bursts. The esp32 firmware
      // pushes 35 wake-word opus frames in ~232ms before sending the
      // ListenMessage(detect) text. If we see more than, say, 5
      // consecutive frames without ever seeing a listen.start, this is
      // almost certainly the wake-word tail — the listen.start we
      // expect is the detect one, which carries text not opus.
      if (session.state === "IDLE") {
        transitionTo(session, "LISTENING");
        log.info(
          `xiaozhi: ${ctx.deviceId} auto-transition IDLE→LISTENING on first opus frame ` +
          `(${event.data.length} bytes; state was IDLE for ${
            Date.now() - session.lastActivityAt
          }ms)`,
        );
      } else if (session.state !== "LISTENING") {
        // Should be unreachable: every other state is handled above.
        // Log loudly so we catch a future code path that introduces
        // a new state and forgets to update this gate.
        log.warn(
          `xiaozhi: ${ctx.deviceId} opus frame arrived in unexpected state=${session.state} ` +
          `(dropping; lastActivityAt was ${
            Date.now() - session.lastActivityAt
          }ms ago)`,
        );
        return;
      }
      appendAudioFrame(session, asBinaryData(event));
      // M3.7.3 debug: log first frame + every 50th to confirm consumption
      const total = session.audioBuffer.length;
      if (total === 1 || total % 50 === 0) {
        log.info(
          `xiaozhi: ${ctx.deviceId} opus frame #${total} (${event.data.length} bytes, ` +
          `state=${session.state}, codec=${(session.codec as { sampleRate?: number }).sampleRate ?? "?"}Hz)`,
        );
      }
    }
  }

  // Detach listeners before cleanup so a late close/error doesn't
  // poke the (now-dead) queue.
  ws.off("message", onAnyMessage as never);
  ws.off("close", onClose);
  ws.off("error", onError);

  cleanupSession(session);
  ctx.sessionStore.unregister(deviceId);
  unregisterEsp32Tools(deviceId);
}

interface WsEvent {
  kind: "text" | "binary";
  data: string | Buffer;
  // Discriminated: text→string, binary→Buffer
  __brand?: never;
}

// Helper: assert text kind has string data
function asTextData(event: WsEvent): string {
  if (event.kind !== "text" || typeof event.data !== "string") {
    throw new Error(`expected text event, got ${event.kind}`);
  }
  return event.data;
}

// Helper: assert binary kind has Buffer data
function asBinaryData(event: WsEvent): Buffer {
  if (event.kind !== "binary" || !Buffer.isBuffer(event.data)) {
    throw new Error(`expected binary event, got ${event.kind}`);
  }
  return event.data;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.alloc(0);
}

/**
 * v0.3.5: deliver a short, local text reply directly to the device
 * without dispatching to the LLM agent. Used by the wake-word
 * short-circuit path: when the user says "你好小智" we don't want
 * the agent to spin up and explain "我是贾维斯" (which it does on
 * every wake-up, even when there's no real question). Mirrors
 * xiaozhi-esp32-server's "enable_greeting + greeting" path.
 *
 * Pipeline matches what the detect deliver-callback does for the
 * real-LLM path, minus the agent dispatch:
 *   1. sendLlmMessage (esp32 display shows the text)
 *   2. transitionTo(SPEAKING)
 *   3. TTS synth → 24kHz opus frames
 *   4. sendTtsAudio (esp32 plays audio)
 *   5. transitionTo(IDLE) in finally
 */
async function deliverLocalReply(
  ctx: Esp32ConnectionCtx,
  session: SessionContext,
  text: string,
  log: Esp32ConnectionCtx["log"],
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  // Bug 2 fix: transition to SPEAKING + send tts.start BEFORE
  // sendLlmMessage (same as dispatch path). Without this, the
  // esp32 firmware sees a text-only LLM line, treats it as a
  // status update, and on the next VAD cycle the wake-word-tail
  // mic frames get re-dispatched as a second "real" turn — that's
  // the "wakes up, says reply twice" bug.
  transitionTo(session, "SPEAKING");
  sendTtsStart(ctx.ws, ctx.sessionId);
  sendLlmMessage(ctx.ws, ctx.sessionId, undefined, trimmed);
  log.info(
    `xiaozhi: ${ctx.deviceId} local reply: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}"`,
  );

  const ttsCfg = (() => {
    try { return getXiaozhiTtsConfig(); } catch (e) {
      log.warn(`xiaozhi: TTS config not available (${(e as Error).message}), skipping audio`);
      return null;
    }
  })();
  if (!ttsCfg) {
    sendTtsStop(ctx.ws, ctx.sessionId);
    markTtsEnded(session, trimmed, log);
    transitionTo(session, "IDLE");
    return;
  }
  const tts = (() => {
    try { return getTTSProvider(ttsCfg); } catch (e) {
      log.warn(`xiaozhi: TTS provider init failed (${(e as Error).message}), skipping audio`);
      return null;
    }
  })();
  if (!tts) {
    sendTtsStop(ctx.ws, ctx.sessionId);
    markTtsEnded(session, trimmed, log);
    transitionTo(session, "IDLE");
    return;
  }

  // Encoder for esp32 TTS audio: 24kHz mono (device output rate,
  // not mic capture rate).
  const encoder = new OpusCodec(24000);
  const ttsStart = Date.now();
  try {
    // v0.4.0-rc1 (batch 1): opt-in streaming TTS pipeline. When
    // `useStreamingTts` is true in the xiaozhi channel config, we
    // run the new 3-queue pipeline. When false (default), we fall
    // through to the legacy `streamTtsToOpusFrames` helper below.
    const channelCfg = getXiaozhiChannelConfig() as { useStreamingTts?: boolean } | undefined;
    if (channelCfg?.useStreamingTts === true) {
      const streamingStart = Date.now();
      const handle = startTtsPipeline({
        ws: ctx.ws,
        sessionId: ctx.sessionId,
        session,
        log: {
          info: (m: string, ...a: unknown[]) => log.info(m, ...a),
          warn: (m: string, ...a: unknown[]) => log.warn(m, ...a),
          error: (m: string, ...a: unknown[]) => log.error(m, ...a),
          debug: (m: string, ...a: unknown[]) => log.debug(m, ...a),
        } as never,
        cfg: { useStreamingTts: true, sampleRate: 24000 },
        tts: tts as never,
        replyText: trimmed,
        onError: (err) => log.error(`xiaozhi: ${ctx.deviceId} streaming tts error:`, (err as Error).message),
      });
      handle.feed(trimmed);
      await handle.close();
      const streamingMs = Date.now() - streamingStart;
      log.info(
        `xiaozhi: ${ctx.deviceId} streaming-tts ${streamingMs}ms (reply=${trimmed.length} chars)`,
      );
      return;
    }
    const opusFrames = await streamTtsToOpusFrames(
      tts as never,
      trimmed,
      encoder,
      {
        info: (m: string, ...a: unknown[]) => log.info(m, ...a),
        warn: (m: string, ...a: unknown[]) => log.warn(m, ...a),
        error: (m: string, ...a: unknown[]) => log.error(m, ...a),
        debug: (m: string, ...a: unknown[]) => log.debug(m, ...a),
      } as never,
      session,
    );
    const ttsMs = Date.now() - ttsStart;
    log.info(
      `xiaozhi: ${ctx.deviceId} tts ${ttsMs}ms → ${opusFrames.length} opus frames ` +
      `(${(trimmed.length / (ttsMs / 1000)).toFixed(0)} chars/sec)`,
    );
    if (opusFrames.length > 0) {
      // Bug 1+2 fix: text already delivered as LLM message; now send
      // sentence_start + frames + stop in the correct order.
      sendTtsSentenceStart(ctx.ws, ctx.sessionId, trimmed);
      sendTtsOpusFrames(ctx.ws, opusFrames);
      sendTtsStop(ctx.ws, ctx.sessionId);
    } else {
      // Edge: no frames produced — still need tts.stop to exit SPEAKING.
      sendTtsStop(ctx.ws, ctx.sessionId);
    }
  } catch (ttsErr) {
    log.error(`xiaozhi: ${ctx.deviceId} TTS encode failed:`, (ttsErr as Error).message);
    // Bug 1 fix: send tts.stop so device doesn't stay in SPEAKING
    try {
      sendTtsStop(ctx.ws, ctx.sessionId);
    } catch { /* ignore */ }
  } finally {
    // markTtsEnded activates the post-TTS echo grace window even when
    // the TTS pipeline failed. Without this, the next VAD stop would
    // possibly trigger a 2nd identical dispatch.
    markTtsEnded(session, trimmed, log);
    transitionTo(session, "IDLE");
  }
}

async function dispatchClientMessage(
  ctx: Esp32ConnectionCtx,
  session: SessionContext,
  msg: ClientMessage,
  log: Esp32ConnectionCtx["log"],
): Promise<void> {
  switch (msg.type) {
    case "hello":
      // Re-hello: ignore (protocol says only 1 hello per connection)
      log.debug(`xiaozhi: ignoring re-hello from ${ctx.deviceId}`);
      return;

    case "listen": {
      if (msg.state === "start") {
        // M3.7.3.1: if we are still in SPEAKING/THINKING (TTS still
        // pushing or agent still thinking), esp32 is just reporting
        // that it heard its own speaker output. Don't start a new
        // listening cycle — just acknowledge and wait for the TTS
        // pipeline to complete its transitionTo(IDLE).
        if (session.state === "SPEAKING" || session.state === "THINKING") {
          log.info(
            `xiaozhi: ${ctx.deviceId} listen start ignored — session in ${session.state} ` +
            `(TTS/agent still busy, mic frames would be speaker echo)`,
          );
          return;
        }
        // Bug 3 fix: clear the aborted flag so a brand-new listen turn
        // can produce fresh TTS audio. (Without this, an abort that
        // landed in the middle of a previous TTS synthesis would leave
        // the flag set, causing the next TTS to bail out at the first
        // chunk — device would play silence for the new turn.)
        session.aborted = false;
        // Bug 7 fix: clear the audio buffer on each listen.start.
        // The esp32 firmware pushes 35 wake-word-tail opus frames in
        // ~232ms before sending the ListenMessage(detect) text, and
        // our IDLE→LISTENING auto-promotion accepts those frames
        // into session.audioBuffer. Without a clear here, the next
        // listen.start (for a real user turn) just *appends* to the
        // same buffer — ASR then transcribes
        // "wake-word-tail + user speech" as a garbled mash, e.g.
        // "你好小小志丽置之志明明今天天天气怎么样" instead of
        // "今天天气怎么样".
        const hadStale = session.audioBuffer.length > 0;
        if (hadStale) {
          log.info(
            `xiaozhi: ${ctx.deviceId} clearing ${session.audioBuffer.length} stale opus ` +
            `frames from previous turn before starting new listen`,
          );
          session.audioBuffer.length = 0;
        }
        // M3.2 stub: just record the start; full audio dispatch lands in M3.4
        // when we have the openclaw channelRuntime wired in.
        transitionTo(session, "LISTENING");
        // M3.7.3 server-side VAD: in non-manual modes esp32 never sends
        // a stop, so we run our own RMS-based VAD and synthesize a stop
        // when 1s of silence follows speech. The official backend
        // (core/providers/vad/silero.py) does the same thing with an
        // ONNX classifier — RMS is good enough for a near-field mic.
        const mode = (msg.mode as "auto" | "manual" | "realtime" | undefined) ?? null;
        session.clientListenMode = mode;
        log.info(
          `xiaozhi: ${ctx.deviceId} listen start, mode=${mode ?? "?"}, ` +
          `sample_rate=${(session as { audioSampleRate?: number }).audioSampleRate ?? "?"}`,
        );
        // Stop any watcher from a previous turn before starting a new one
        if (session.vadWatcher) {
          session.vadWatcher.stop();
          session.vadWatcher = null;
        }
        if (mode !== "manual") {
          session.vadWatcher = startVadWatcher({
            deviceId: ctx.deviceId,
            session,
            log: {
              info: (m, ...a) => log.info(m, ...a),
              warn: (m, ...a) => log.warn(m, ...a),
              error: (m, ...a) => log.error(m, ...a),
              debug: (m, ...a) => log.debug(m, ...a),
            },
            onSilence: async () => {
              // v0.3.6: post-TTS echo suppression (fixes "wakes up,
              // says reply twice" bug). Right after our TTS push ends,
              // the esp32 mic re-captures the TTS audio we just sent
              // (the device has no AEC). If we let the VAD fire on
              // that echo, ASR returns garbage, the agent loop gets
              // dispatched, and the user hears the same reply twice.
              // We suppress the dispatch for POST_TTS_GRACE_MS (2s by
              // default) after TTS ends, then resume normal VAD
              // behavior on the *next* listen.start.
              if (isInPostTtsGrace(session)) {
                log.info(
                  `xiaozhi: ${ctx.deviceId} VAD stop suppressed — ` +
                  `inside post-TTS grace window (last reply was "${session.lastTtsText?.slice(0, 40)}")`,
                );
                // Bug 5 fix: only suppress if the buffer is empty /
                // low-energy (echo). If the buffer has real speech
                // (rms above threshold), the user is actually
                // talking over the post-TTS echo — let it through.
                const hasSpeech = bufferHasSpeech(session);
                if (hasSpeech) {
                  log.info(
                    `xiaozhi: ${ctx.deviceId} VAD stop NOT suppressed — ` +
                    `real speech detected in buffer during grace window`,
                  );
                  // Fall through to normal dispatch
                } else {
                  // Drain the buffer anyway so we don't accumulate
                  // future echo frames, but skip the ASR+dispatch.
                  drainAudioBuffer(session);
                  transitionTo(session, "IDLE");
                  return;
                }
              }
              // Mirror what ListenMessage(stop) would do — drain audio,
              // run ASR, dispatch to LLM, push TTS. handleListenStop
              // transitions state to IDLE on completion, which is fine:
              // esp32 in realtime mode will then see a tts state=stop
              // from us and re-enter LISTENING (it never actually
              // returns to idle in this mode, so this loop is by
              // design — user keeps talking, VAD keeps triggering).
              await handleListenStop(ctx, session);
              // After dispatch, esp32 will push a fresh listen.start
              // on the next wake word / touch key. The new start will
              // tear this watcher down and start a fresh one. If no
              // new start comes, we just sit here.
            },
          });
        }
      } else if (msg.state === "stop") {
        // M3.4c/d: full pipeline — drain → ASR → dispatch → TTS
        // Also tear down our VAD watcher — esp32 took over, no need to
        // race the user's listen.stop with our 1s-silence trigger.
        if (session.vadWatcher) {
          session.vadWatcher.stop();
          session.vadWatcher = null;
        }
        await handleListenStop(ctx, session);
        return;
      } else if (msg.state === "detect") {
        // Listen(detect) + text — bypass ASR, send text directly.
        // The detect path is the wake-word path: esp32's on-board AFE
        // recognized "你好小智" and pushed the recognized text along
        // with a state=detect marker. This is the only path that
        // doesn't need ASR on our side.
        // Also stop the VAD watcher if any — wake word implies the
        // device is now in a new turn, the old turn's audio is moot.
        if (session.vadWatcher) {
          session.vadWatcher.stop();
          session.vadWatcher = null;
        }
        const text = (msg.text ?? "").trim();
        if (text.length === 0) {
          log.warn(`xiaozhi: ${ctx.deviceId} detect with empty text`);
          return;
        }
        log.info(`xiaozhi: ${ctx.deviceId} detect: ${text}`);

        // v0.3.5: wake-word short-circuit (mirrors official
        //   xiaozhi-esp32-server core/handle/textHandler/listenMessageHandler.py).
        //   The official backend distinguishes wake-up words from real
        //   user input: if the text matches a configured wakeup_word,
        //   it sends STT echo + a fixed greeting (or just tts=stop if
        //   enable_greeting=false) — it does NOT dispatch to the LLM.
        //   This is the fix for "every wake-up says 我是贾维斯 twice":
        //   plugin previously dispatched the wake word to the agent
        //   loop, the agent always answered with the same self-intro,
        //   and on the next VAD cycle the esp32 mic picked up the TTS
        //   echo and triggered a second identical reply.
        const xCfg = getXiaozhiChannelConfig() as {
          wakeupWords?: string[];
          enableGreeting?: boolean;
          greeting?: string;
        } | undefined;
        const wakeupWords = xCfg?.wakeupWords ?? [];
        if (wakeupWords.length > 0) {
          const filtered = stripPunctuation(text);
          const isWakeup = wakeupWords.some(
            (w) => stripPunctuation(w) === filtered,
          );
          if (isWakeup) {
            log.info(
              `xiaozhi: ${ctx.deviceId} detect is wakeup word ` +
              `("${text}" matches wakeup_words) — short-circuiting ` +
              `agent dispatch`,
            );
            // 1. STT echo so esp32 display shows the recognized text
            sendSttMessage(ctx.ws, ctx.sessionId, text);
            // 2. Skip LLM dispatch (the wake word is not a real user
            //    question — it's just the user saying "hi, wake up").
            //    Either play the configured greeting or send tts=stop
            //    if greetings are disabled. The device returns to
            //    idle and waits for the next user command.
            const enableGreeting = xCfg?.enableGreeting !== false;
            if (!enableGreeting) {
              sendTtsAudio(ctx.ws, ctx.sessionId, "", []);
              log.info(
                `xiaozhi: ${ctx.deviceId} enableGreeting=false, ` +
                `sent tts=stop, returning to idle`,
              );
            } else {
              const greeting =
                typeof xCfg?.greeting === "string" && xCfg.greeting.length > 0
                  ? xCfg.greeting
                  : "嘿，你好呀";
              await deliverLocalReply(ctx, session, greeting, log);
            }
            return;
          }
        }

        transitionTo(session, "THINKING");

        // Dispatch into openclaw agent loop
        const runtime = getXiaozhiRuntime();
        if (!runtime) {
          log.error(`xiaozhi: runtime not initialized, dropping detect text`);
          transitionTo(session, "IDLE");
          return;
        }
        const dmRuntime = buildDirectDmRuntime(runtime) as never;
        try {
          // Send STT echo first so esp32 displays the recognized text
          sendSttMessage(ctx.ws, ctx.sessionId, text);

          const dispatchResult = await dispatchInboundDirectDmWithRuntime({
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
              // M3.7.3: wire up the TTS pipeline that was stubbed in
              // M3.3b. The text was being delivered to the device as an
              // LLM message (which is why the esp32 display showed it)
              // but the audio never reached the speaker. This mirrors
              // the TTS path that handleListenStop has used since M3.4d.
              const text = String((payload as { text?: string })?.text ?? "").trim();
              if (!text) return;
              sendLlmMessage(ctx.ws, ctx.sessionId, undefined, text);
              log.info(`xiaozhi: ${ctx.deviceId} delivered: ${text.slice(0, 80)}`);

              // Synthesize + stream TTS audio. Use the session's
              // negotiated audio params so the encoder matches what
              // the device expects (16kHz mono / 60ms frames).
              const ttsCfg = (() => {
                try { return getXiaozhiTtsConfig(); } catch (e) {
                  log.warn(`xiaozhi: TTS config not available (${(e as Error).message}), skipping audio`);
                  return null;
                }
              })();
              if (!ttsCfg) return;
              const tts = (() => {
                try { return getTTSProvider(ttsCfg); } catch (e) {
                  log.warn(`xiaozhi: TTS provider init failed (${(e as Error).message}), skipping audio`);
                  return null;
                }
              })();
              if (!tts) return;

              const sampleRate = (session as { audioSampleRate?: number }).audioSampleRate ?? 24000;
              // OpusCodec requires a literal sample rate (8000|16000|24000|48000).
              // esp32 negotiates 16kHz mic but the device output is 24kHz, so
              // we always encode TTS at 24kHz to match the speaker pipeline.
              const encoderSampleRate = 24000 as const;
              const encoder = new OpusCodec(encoderSampleRate);
              void sampleRate;
              // Bug 2: transition + tts.start BEFORE LLM message
              transitionTo(session, "SPEAKING");
              sendTtsStart(ctx.ws, ctx.sessionId);
              // Send LLM message AFTER tts.start so the esp32 display
              // doesn't briefly show a text-only LLM line
              sendLlmMessage(ctx.ws, ctx.sessionId, undefined, text);
              const ttsStart = Date.now();
              try {
                // v0.4.0-rc1 (batch 1): opt-in streaming TTS pipeline.
                // The flag is read on every deliver callback; the
                // legacy `streamTtsToOpusFrames` path runs unchanged
                // when useStreamingTts is false (default).
                const channelCfg = getXiaozhiChannelConfig() as { useStreamingTts?: boolean } | undefined;
                if (channelCfg?.useStreamingTts === true) {
                  const streamingStart = Date.now();
                  const handle = startTtsPipeline({
                    ws: ctx.ws,
                    sessionId: ctx.sessionId,
                    session,
                    log: {
                      info: (m: string, ...a: unknown[]) => log.info(m, ...a),
                      warn: (m: string, ...a: unknown[]) => log.warn(m, ...a),
                      error: (m: string, ...a: unknown[]) => log.error(m, ...a),
                      debug: (m: string, ...a: unknown[]) => log.debug(m, ...a),
                    } as never,
                    cfg: { useStreamingTts: true, sampleRate: 24000 },
                    tts: tts as never,
                    replyText: text,
                    onError: (err) => log.error(`xiaozhi: ${ctx.deviceId} streaming tts error:`, (err as Error).message),
                  });
                  handle.feed(text);
                  await handle.close();
                  const streamingMs = Date.now() - streamingStart;
                  log.info(
                    `xiaozhi: ${ctx.deviceId} streaming-tts ${streamingMs}ms (reply=${text.length} chars)`,
                  );
                  markTtsEnded(session, text, log);
                  return;
                }
                const opusFrames = await streamTtsToOpusFrames(
                  tts as never,
                  text,
                  encoder,
                  {
                    info: (m: string, ...a: unknown[]) => log.info(m, ...a),
                    warn: (m: string, ...a: unknown[]) => log.warn(m, ...a),
                    error: (m: string, ...a: unknown[]) => log.error(m, ...a),
                    debug: (m: string, ...a: unknown[]) => log.debug(m, ...a),
                  } as never,
                  session,
                );
                const ttsMs = Date.now() - ttsStart;
                log.info(
                  `xiaozhi: ${ctx.deviceId} tts ${ttsMs}ms → ${opusFrames.length} opus frames ` +
                  `(${(text.length / (ttsMs / 1000)).toFixed(0)} chars/sec)`,
                );
                if (opusFrames.length > 0) {
                  sendTtsSentenceStart(ctx.ws, ctx.sessionId, text);
                  sendTtsOpusFrames(ctx.ws, opusFrames);
                }
                sendTtsStop(ctx.ws, ctx.sessionId);
                // v0.3.6: mark TTS ended so the post-TTS echo grace
                // window activates. Without this, the next VAD stop
                // dispatches a 2nd identical reply to the agent loop.
                markTtsEnded(session, text, log);
              } catch (err) {
                log.error(`xiaozhi: ${ctx.deviceId} TTS failed: ${(err as Error).message}`);
                // Bug 1 fix: ensure tts.stop is sent + grace window
                // activated even when TTS fails.
                try {
                  sendTtsStop(ctx.ws, ctx.sessionId);
                } catch { /* ignore */ }
                markTtsEnded(session, text, log);
              }
            },
            onRecordError: (err) => log.error(`xiaozhi: record error:`, err),
            onDispatchError: (err) => log.error(`xiaozhi: dispatch error:`, err),
          });

          log.info(`xiaozhi: ${ctx.deviceId} dispatch complete (sessionKey=${dispatchResult.route.sessionKey})`);
        } catch (err) {
          log.error(`xiaozhi: dispatch failed for ${ctx.deviceId}:`, (err as Error).message);
          sendLlmMessage(ctx.ws, ctx.sessionId, undefined, `Error: ${(err as Error).message}`);
        } finally {
          transitionTo(session, "IDLE");
        }
      }
      return;
    }

    case "abort": {
      // Bug 3 fix: set the aborted flag so any in-flight TTS synthesis
      // (running in the deliver callback's streamTtsToOpusFrames loop)
      // breaks out early on the next chunk. The deliver callback's
      // finally block (markTtsEnded + tts.stop) will still run and
      // ensure the device cleanly exits SPEAKING state.
      log.info(`xiaozhi: ${ctx.deviceId} abort (${msg.reason ?? "no reason"})`);
      session.aborted = true;
      // Tear down the VAD watcher — we don't want a queued silence
      // detection to fire after the user has explicitly aborted.
      if (session.vadWatcher) {
        session.vadWatcher.stop();
        session.vadWatcher = null;
      }
      transitionTo(session, "IDLE");
      return;
    }

    case "mcp": {
      // esp32 → bridge: could be request or response
      const payload = msg.payload as { id?: string | number; method?: string; result?: unknown; error?: unknown };
      if (payload.id !== undefined && !payload.method) {
        // Response to a bridge-issued request (M3.7)
        const id = String(payload.id);
        // Distinguish tools/list (MCP handshake) from tools/call (after dispatch).
        // The bridge only ever sends tools/list during handshake and tools/call
        // per LLM call, so the cleanest signal is "result has .tools[]".
        const isToolsList =
          payload.result !== undefined &&
          typeof payload.result === "object" &&
          Array.isArray((payload.result as { tools?: unknown }).tools);
        if (isToolsList) {
          // M3.7.2: register the tool list into the esp32 Tool Registry
          // so the ChannelAgentToolFactory (createEsp32DeviceToolRouter)
          // can route LLM tool calls back to this device's WebSocket.
          const tools = (payload.result as { tools: McpTool[] }).tools;
          registerEsp32Tools(ctx.deviceId, {
            tools,
            ws: ctx.ws,
            session,
            lastReportedAt: Date.now(),
          });
          log.info(
            `xiaozhi: ${ctx.deviceId} registered ${tools.length} esp32 tools: ${tools.map((t) => t.name).join(", ")}`,
          );
          // Backward compat: also call ctx.onEsp32ToolsList if set.
          if (ctx.onEsp32ToolsList) {
            ctx.onEsp32ToolsList(tools).catch((err: unknown) => {
              log.warn(`xiaozhi: onEsp32ToolsList handler failed: ${(err as Error).message}`);
            });
          }
          return;
        }
        const ok = resolveMcpResponse(session, id, payload);
        if (!ok) log.warn(`xiaozhi: received MCP response for unknown id ${id}`);
      } else if (payload.method) {
        // v0.3.7 (M4 fix): Request from esp32 → dispatch to openclaw
        // agent tool router via mcp/inbound.ts handleEsp32McpRequest.
        // Supports both "tools/list" (return openclaw tool catalog)
        // and "tools/call" (execute a named tool, return result).
        try {
          await handleEsp32McpRequest(ctx.ws, session, msg as never, log);
        } catch (err) {
          log.error(
            `xiaozhi: ${ctx.deviceId} mcp request ${payload.method} failed:`,
            (err as Error).message,
          );
        }
      }
      return;
    }
  }
}
