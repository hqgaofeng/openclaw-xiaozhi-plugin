/**
 * xiaozhi WebSocket message schemas + parser/serializer.
 *
 * 4 client→server message types:
 *   - HelloMessage   (handshake initial)
 *   - ListenMessage  (audio start/stop/detect)
 *   - AbortMessage   (cancel current turn)
 *   - MCPMessage     (JSON-RPC 2.0)
 *
 * 5 server→client message types:
 *   - ServerHello
 *   - STTMessage
 *   - LLMMessage
 *   - TTSMessage
 *   - SystemMessage
 *
 * 1:1 translation of bridge/src/xiaozhi_bridge/protocol/messages.py.
 *
 * @see docs/sdk-research-v3.md §1.1 for the full message table.
 * @see docs/protocol.md (xiaozhi-bridge) for the Python reference.
 */

import { z } from "zod";

// ---- Client → Server ----

export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  version: z.number(),
  features: z.object({
    mcp: z.boolean().optional(),
  }).optional(),
  transport: z.literal("websocket").optional(),
  audio_params: z.object({
    format: z.literal("opus"),
    sample_rate: z.literal(16000),
    channels: z.literal(1),
    frame_duration: z.literal(60),
  }),
});

export const ListenMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("listen"),
  state: z.enum(["start", "stop", "detect"]),
  mode: z.enum(["auto", "manual", "realtime"]).optional(),
  text: z.string().optional(),
});

export const AbortMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("abort"),
  reason: z.string().optional(),
});

export const MCPMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("mcp"),
  payload: z.record(z.unknown()),
});

export const ClientMessageSchema = z.union(
  [HelloMessageSchema, ListenMessageSchema, AbortMessageSchema, MCPMessageSchema] as const,
);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ListenMessage = z.infer<typeof ListenMessageSchema>;
export type AbortMessage = z.infer<typeof AbortMessageSchema>;
export type MCPMessage = z.infer<typeof MCPMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- Server → Client ----

export const ServerHelloSchema = z.object({
  type: z.literal("hello"),
  transport: z.literal("websocket"),
  session_id: z.string(),
  audio_params: z.object({
    format: z.literal("opus"),
    // M3.3c: echo the client audio_params instead of locking to 24kHz —
    // esp32 firmware validates the negotiated sample_rate match and
    // disconnects on mismatch (we hit this on the first real-device test
    // — 30ms disconnect after serverHello). Accept any reasonable rate.
    sample_rate: z.union([z.literal(8000), z.literal(16000), z.literal(24000), z.literal(48000)]),
    channels: z.union([z.literal(1), z.literal(2)]),
    frame_duration: z.union([z.literal(20), z.literal(40), z.literal(60), z.literal(80), z.literal(100), z.literal(120)]),
  }),
});

export const STTMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("stt"),
  text: z.string(),
});

export const LLMMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("llm"),
  emotion: z.string().optional(),
  text: z.string(),
});

export const TTSMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("tts"),
  state: z.enum(["start", "sentence_start", "stop"]),
  text: z.string().optional(),
});

export const SystemMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.literal("system"),
  command: z.string(),
});

export const ServerMessageSchema = z.union(
  [ServerHelloSchema, STTMessageSchema, LLMMessageSchema, TTSMessageSchema, SystemMessageSchema] as const,
);

export type ServerHello = z.infer<typeof ServerHelloSchema>;
export type STTMessage = z.infer<typeof STTMessageSchema>;
export type LLMMessage = z.infer<typeof LLMMessageSchema>;
export type TTSMessage = z.infer<typeof TTSMessageSchema>;
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- Parser / Serializer ----

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessageSchema.parse(JSON.parse(raw));
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
