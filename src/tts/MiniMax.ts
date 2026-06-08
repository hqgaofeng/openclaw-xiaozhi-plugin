/**
 * MiniMax T2A v2 TTS provider — WebSocket streaming.
 *
 * Endpoint: wss://api.minimaxi.com/ws/v1/t2a_v2
 * Model:    speech-2.8-hd (default; speech-2.8-turbo as alt)
 * Voice:    female-shaonv (default; supports 100+ Chinese voices)
 * Audio:    pcm @ 24kHz mono int16 (xiaozhi protocol compatible)
 *
 * ## Protocol (MiniMax T2A v2 WebSocket)
 *
 * Client → Server:
 *   1. { event: "task_start",  model, voice_setting, audio_setting, stream: true }
 *   2. { event: "task_continue", text: "sentence 1" }
 *   3. { event: "task_continue", text: "sentence 2" }
 *   4. { event: "task_finish" }
 *
 * Server → Client:
 *   - { event: "task_started",   session_id }
 *   - { event: "audio",          data: "<hex pcm chunk>" }   // repeated
 *   - { event: "sentence_start", text, offset_ms }
 *   - { event: "task_finished" }
 *   - { event: "task_failed",    error_code, error_msg }
 *
 * ## 3 V2 lessons carried over (V2 used edge-tts, but same gotchas apply)
 *
 * 1. Streaming TTS **must** expose an async generator — esp32 expects
 *    `tts sentence_start` BEFORE the full text is done. We yield a
 *    TTSChunk for each `audio` event (one PCM frame ~60-100ms).
 *
 * 2. Audio format must match xiaozhi protocol: PCM int16 mono 24kHz.
 *    MiniMax supports `audio_setting.format = "pcm"` + `sample_rate = 24000`
 *    → no ffmpeg transcoding needed (vs V2 edge-tts which needed mp3→pcm).
 *
 * 3. WebSocket lifecycle: ONE ws connection per synthesize() call.
 *    Reusing the ws across calls is a deadlock trap (the server closes
 *    after task_finished). We open/close per call. (Latency is ~50ms
 *    TLS handshake, fine for short LLM replies.)
 *
 * ## Why not HTTP mode?
 *
 * The HTTP endpoint returns ONE base64 blob per request → no streaming
 * → esp32 receives TTS state "start" only after the whole reply is
 * synthesized → 5-10s of silence before first audio. WebSocket avoids this.
 */

import WebSocket from "ws";
import { TTSError, type TTSChunk, type TTSProvider } from "./types.js";

/** Subset of MiniMax T2A v2 task_start we care about. */
interface MiniMaxTaskStart {
  event: "task_start";
  model: string;
  voice_setting: {
    voice_id: string;
    speed?: number;
    vol?: number;
    pitch?: number;
  };
  audio_setting: {
    sample_rate: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
    bitrate: 32000 | 64000 | 128000 | 256000;
    format: "pcm" | "mp3" | "opus";
    channel: 1 | 2;
  };
  stream: true;
}

export interface MiniMaxTTSOptions {
  /** API key. Defaults to process.env.MINIMAX_API_KEY. */
  apiKey?: string;
  /** MiniMax T2A v2 model. Default: "speech-2.8-hd". */
  model?: string;
  /** Voice id. Default: "female-shaonv" (Chinese young female). */
  voice?: string;
  /** Sample rate. Default: 24000 (xiaozhi protocol). */
  sampleRate?: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  /** Speech speed 0.5-2.0. Default: 1.0. */
  speed?: number;
  /** Volume 0-10. Default: 1. */
  volume?: number;
  /** Pitch -12 to 12. Default: 0. */
  pitch?: number;
  /** Connection timeout ms. Default: 10000. */
  connectTimeoutMs?: number;
}

const ENDPOINT = "wss://api.minimaxi.com/ws/v1/t2a_v2";
const DEFAULT_MODEL = "speech-2.8-hd";
const DEFAULT_VOICE = "female-shaonv";

export class MiniMaxTTS implements TTSProvider {
  readonly name = "MiniMaxTTS";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly sampleRate: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  private readonly speed: number;
  private readonly volume: number;
  private readonly pitch: number;
  private readonly connectTimeoutMs: number;
  private disposed = false;

  constructor(opts: MiniMaxTTSOptions = {}) {
    const key = opts.apiKey ?? process.env.MINIMAX_API_KEY;
    if (!key) {
      throw new TTSError("MiniMax TTS: apiKey or MINIMAX_API_KEY env var required");
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.voice = opts.voice ?? DEFAULT_VOICE;
    this.sampleRate = opts.sampleRate ?? 24000;
    this.speed = opts.speed ?? 1.0;
    this.volume = opts.volume ?? 1;
    this.pitch = opts.pitch ?? 0;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
  }

  async *synthesize(text: string): AsyncGenerator<TTSChunk> {
    if (this.disposed) throw new TTSError("MiniMaxTTS disposed");
    if (!text.trim()) {
      // Nothing to synthesize — yield a single "empty" chunk so callers
      // can still emit tts start/stop.
      yield {
        pcm: Buffer.alloc(0),
        text: "",
        sampleRate: this.sampleRate,
        isFirst: true,
        isLast: true,
      };
      return;
    }

    // Split on sentence boundaries for sentence_start alignment.
    // MiniMax T2A v2 streams continuously within a task; we approximate
    // sentence boundaries by splitting input on `。！？\n` (ZH punctuation).
    const sentences = splitSentences(text);

    const ws = await this.openConnection();
    let isFirst = true;

    try {
      for (const sentence of sentences) {
        if (this.disposed) break;
        // task_continue with one sentence; MiniMax yields audio chunks for it.
        const msg = JSON.stringify({ event: "task_continue", text: sentence });
        ws.send(msg);

        // Drain audio frames until MiniMax sends a non-audio event for this
        // sentence. MiniMax interleaves `sentence_start` between sentences
        // when stream=true and you send multiple task_continue.
        for await (const frame of this.readFrames(ws, sentence, isFirst)) {
          yield frame;
          isFirst = false;
          if (frame.isLast) break;
        }
      }

      // End the task — MiniMax sends task_finished → ws closes.
      ws.send(JSON.stringify({ event: "task_finish" }));
    } finally {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private openConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = `${ENDPOINT}?model=${encodeURIComponent(this.model)}`;
      const ws = new WebSocket(url, {
        headers: {
          // MiniMax auth uses either Authorization header (api_key) or
          // X-Api-Key. We use the same scheme the LLM provider uses
          // (api_key mode in auth-profiles.json).
          Authorization: `Bearer ${this.apiKey}`,
        },
        handshakeTimeout: this.connectTimeoutMs,
      });

      let started = false;

      const timer = setTimeout(() => {
        if (!started) {
          ws.terminate();
          reject(new TTSError(`MiniMax TTS: connect timeout after ${this.connectTimeoutMs}ms`));
        }
      }, this.connectTimeoutMs);

      ws.once("open", () => {
        // Send task_start BEFORE resolving.
        const taskStart: MiniMaxTaskStart = {
          event: "task_start",
          model: this.model,
          voice_setting: {
            voice_id: this.voice,
            speed: this.speed,
            vol: this.volume,
            pitch: this.pitch,
          },
          audio_setting: {
            sample_rate: this.sampleRate,
            bitrate: 128000,
            format: "pcm",
            channel: 1,
          },
          stream: true,
        };
        ws.send(JSON.stringify(taskStart));
        started = true;
        clearTimeout(timer);
        resolve(ws);
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new TTSError(`MiniMax TTS: ws connect failed: ${err.message}`, err));
      });

      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new TTSError(`MiniMax TTS: HTTP ${res.statusCode} ${res.statusMessage}`));
      });
    });
  }

  private async *readFrames(
    ws: WebSocket,
    sentence: string,
    firstInStream: boolean,
  ): AsyncGenerator<TTSChunk> {
    // Buffer of half-received messages.
    let sawAudioForSentence = false;
    let pendingText = sentence;

    while (!this.disposed) {
      // Wait for next message.
      const msg = await new Promise<unknown>((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData) => {
          ws.off("error", onError);
          ws.off("close", onClose);
          resolve(data);
        };
        const onError = (err: Error) => {
          ws.off("message", onMessage);
          ws.off("close", onClose);
          reject(new TTSError(`MiniMax TTS: ws error mid-stream: ${err.message}`, err));
        };
        const onClose = () => {
          ws.off("message", onMessage);
          ws.off("error", onError);
          reject(new TTSError("MiniMax TTS: ws closed mid-stream"));
        };
        ws.once("message", onMessage);
        ws.once("error", onError);
        ws.once("close", onClose);
      });

      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse((msg as WebSocket.RawData).toString()) as Record<string, unknown>;
      } catch {
        // Ignore non-JSON frames (shouldn't happen with MiniMax T2A).
        continue;
      }

      const event = payload.event as string | undefined;

      if (event === "audio" && typeof payload.data === "string") {
        // hex-encoded PCM int16 samples.
        const pcm = Buffer.from(payload.data, "hex");
        sawAudioForSentence = true;
        yield {
          pcm,
          text: pendingText,
          sampleRate: this.sampleRate,
          isFirst: firstInStream && !sawAudioForSentence,
          isLast: false,
        };
        firstInStream = false;
      } else if (event === "sentence_start") {
        // MiniMax signals end of one sentence and start of next. Our
        // explicit task_continue per sentence is more deterministic, but
        // we honor this in case MiniMax batches differently.
        const offsetMs = (payload.offset_ms as number) ?? 0;
        void offsetMs; // future: track latency
      } else if (event === "task_finished") {
        // End of stream — yield a final chunk with isLast=true so the
        // outbound adapter emits tts state=stop.
        yield {
          pcm: Buffer.alloc(0),
          text: pendingText,
          sampleRate: this.sampleRate,
          isFirst: false,
          isLast: true,
        };
        return;
      } else if (event === "task_failed") {
        const errMsg = (payload.error_msg as string) ?? "unknown";
        const errCode = (payload.error_code as number) ?? -1;
        throw new TTSError(`MiniMax TTS: task_failed (${errCode}): ${errMsg}`);
      }
      // Ignore other events (task_started, etc).
    }
  }
}

/** Split text on ZH/EN sentence boundaries. Used to send one
 *  task_continue per sentence for sentence_start alignment. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  // Split on 。！？；\n + English . ! ? (followed by space or end)
  const re = /[^。！？；\n.!?]+[。！？；.!?]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const s = match[0].trim();
    if (s) out.push(s);
  }
  if (out.length === 0 && text.trim()) {
    out.push(text.trim());
  }
  return out;
}
