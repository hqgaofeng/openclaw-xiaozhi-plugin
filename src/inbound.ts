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
import { buildDirectDmRuntime, getXiaozhiRuntime, getXiaozhiConfig } from "./api.js";
import { sendSttMessage, sendLlmMessage } from "./outbound.js";
import { OpusCodec } from "./audio.js";
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
  transitionTo,
  type SessionContext,
} from "./session.js";
import type { SessionStore } from "./gateway.js";
import { resolveMcpResponse } from "./mcp/outbound.js";
import { registerEsp32Tools, unregisterEsp32Tools } from "./mcp/registry.js";
import type { McpTool } from "./mcp/protocol.js";
import { handleListenStop } from "./handle/esp32ListenHandler.js";

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

  // 1. Wait for Hello
  const helloMsg = await waitForJsonMessage(ws, "hello", log);
  if (!helloMsg) {
    log.warn(`xiaozhi: ${deviceId} disconnected before Hello`);
    return;
  }

  // 2. Reply with ServerHello (echo client's audio_params so esp32 accepts
  //    the negotiated format; V2 bridge also echoed 1:1, see
  //    bridge/server.py:_handle_hello). esp32 firmware validates the
  //    sample_rate match and disconnects on mismatch (we hit this on the
  //    first real-device test — 30ms disconnect, 1008 close on mismatch).
  const clientAudioParams = (helloMsg as { audio_params?: { sample_rate?: number; channels?: number; frame_duration?: number } }).audio_params
    ?? { format: "opus" as const, sample_rate: 16000, channels: 1, frame_duration: 60 };
  const serverHello = {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: "opus" as const,
      sample_rate: clientAudioParams.sample_rate ?? 16000,
      channels: clientAudioParams.channels ?? 1,
      frame_duration: clientAudioParams.frame_duration ?? 60,
    },
  } as ServerHello;
  ws.send(serializeServerMessage(serverHello));
  log.info(`xiaozhi: ${deviceId} hello acked, session=${sessionId}`);

  // 3. Message loop
  let isClosed = false;
  ws.on("close", () => { isClosed = true; });

  while (!isClosed) {
    const event = await nextEvent(ws, log);
    if (!event) break;  // closed

    if (event.kind === "text") {
      try {
        const msg = parseClientMessage(asTextData(event));
        await dispatchClientMessage(ctx, session, msg, log);
      } catch (err) {
        console.error("BAD MSG", deviceId, err); log.warn(`xiaozhi: bad message from ${deviceId}:`, (err as Error)?.stack ?? (err as Error)?.message ?? String(err));
      }
    } else if (event.kind === "binary") {
      // Opus frame for the active Listen session
      if (session.state !== "LISTENING") {
        log.debug(`xiaozhi: dropped binary frame in state ${session.state}`);
        continue;
      }
      appendAudioFrame(session, asBinaryData(event));
    }
  }

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

async function nextEvent(ws: WebSocket, log: Esp32ConnectionCtx["log"]): Promise<WsEvent | null> {
  return new Promise((resolve) => {
    function onAnyMessage(data: unknown, isBinary: boolean) {
      cleanup();
      if (isBinary) {
        const buf = toBuffer(data);
        resolve({ kind: "binary", data: buf });
      } else {
        const text = typeof data === "string" ? data : toBuffer(data).toString("utf8");
        resolve({ kind: "text", data: text });
      }
    }
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      log.warn(`xiaozhi: ws error:`, err.message);
      cleanup();
      resolve(null);
    };
    function cleanup() {
      ws.off("message", onAnyMessage as never);
      ws.off("close", onClose);
      ws.off("error", onError);
    }
    ws.on("message", onAnyMessage as never);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.alloc(0);
}

async function waitForJsonMessage(
  ws: WebSocket,
  expectedType: string,
  log: Esp32ConnectionCtx["log"],
): Promise<ClientMessage | null> {
  const event = await nextEvent(ws, log);
  if (!event) return null;
  if (event.kind !== "text") {
    log.warn(`xiaozhi: expected JSON ${expectedType}, got binary`);
    return null;
  }
  const msg = parseClientMessage(asTextData(event));
  if (msg.type !== expectedType) {
    log.warn(`xiaozhi: expected ${expectedType}, got ${msg.type}`);
    return null;
  }
  return msg;
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
        // M3.2 stub: just record the start; full audio dispatch lands in M3.4
        // when we have the openclaw channelRuntime wired in.
        transitionTo(session, "LISTENING");
        log.info(`xiaozhi: ${ctx.deviceId} listen start, sample_rate=${(session as { audioSampleRate?: number }).audioSampleRate ?? "?"}`);
      } else if (msg.state === "stop") {
        // M3.4c/d: full pipeline — drain → ASR → dispatch → TTS
        await handleListenStop(ctx, session);
        return;
      } else if (msg.state === "detect") {
        // Listen(detect) + text — bypass ASR, send text directly
        const text = (msg.text ?? "").trim();
        if (text.length === 0) {
          log.warn(`xiaozhi: ${ctx.deviceId} detect with empty text`);
          return;
        }
        log.info(`xiaozhi: ${ctx.deviceId} detect: ${text}`);
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
              // M3.3b: outbound text only (no TTS audio yet).
              // TTS pipeline lands in M3.4.
              const text = String((payload as { text?: string })?.text ?? "").trim();
              if (text) {
                sendLlmMessage(ctx.ws, ctx.sessionId, undefined, text);
                log.info(`xiaozhi: ${ctx.deviceId} delivered: ${text.slice(0, 80)}`);
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
      log.info(`xiaozhi: ${ctx.deviceId} abort (${msg.reason ?? "no reason"})`);
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
        // Request from esp32 to bridge (M3.7 — dynamic tool call)
        log.info(`xiaozhi: ${ctx.deviceId} mcp request: ${payload.method}`);
        // M3.7: forward to openclaw agent tool router
      }
      return;
    }
  }
}
