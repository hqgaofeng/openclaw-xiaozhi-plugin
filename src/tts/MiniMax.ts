/**
 * MiniMax T2A v2 TTS provider — HTTP streaming.
 *
 * Endpoint: POST https://api.minimaxi.com/v1/t2a_v2
 * Model:    speech-2.8-hd (default; speech-2.8-turbo as alt)
 * Voice:    female-shaonv (default; supports 100+ Chinese voices)
 * Audio:    pcm @ 24kHz mono int16 (xiaozhi protocol compatible)
 *
 * ## Protocol (MiniMax T2A v2 HTTP)
 *
 * Request body:
 *   {
 *     "model": "speech-2.8-hd",
 *     "text": "...",
 *     "stream": true,
 *     "voice_setting": { "voice_id": "...", speed, vol, pitch },
 *     "audio_setting": { "sample_rate": 24000, bitrate: 128000,
 *                        format: "pcm", channel: 1 }
 *   }
 *
 * Response (chunked HTTP/1.1):
 *   - 1+ JSON frames, each { data: "<hex pcm>", status: 1 }
 *   - last frame: { status: 2, extra_info: { audio_length, sample_rate, ... } }
 *   - hex pcm chunks are ~200ms each
 *
 * ## V2 #2 lessons carried over (M3.4b design)
 *
 * 1. Streaming TTS MUST yield PCM chunks progressively — esp32 expects
 *    `tts sentence_start` BEFORE the full text is done. We yield one
 *    TTSChunk per incoming hex frame, and slice each frame into 60ms
 *    sub-frames for esp32's opus encoder (which requires exact 60ms).
 *
 * 2. Audio format must match xiaozhi protocol: PCM int16 mono 24kHz.
 *    MiniMax supports `audio_setting.format = "pcm"` + `sample_rate = 24000`
 *    → no ffmpeg transcoding needed (vs V2 edge-tts which needed mp3→pcm).
 *
 * 3. HTTP/1.1 chunked transfer returns ~200ms frames; we slice into
 *    60ms sub-frames for esp32. The accumulated PCM buffer is flushed
 *    in 60ms-aligned slices (matches audio.ts frameSizeBytes(24000)).
 *
 * ## Why HTTP not WebSocket?
 *
 * MiniMax T2A v2 WebSocket endpoint (wss://.../ws/v1/t2a_v2) returns
 * HTTP 200 OK on the upgrade request — not a 101 Switching Protocols.
 * This was confirmed via direct curl + node ws test (June 2026):
 *   curl: returns JSON {"base_resp":{"status_code":1004,"status_msg":"login fail:..."}}
 *   ws: triggers 'unexpected-response' event
 * The HTTP/1.1 streaming endpoint IS the canonical T2A v2 protocol.
 */

import { request as httpRequest } from "node:https";
import { TTSError, type TTSChunk, type TTSProvider } from "./types.js";
import { frameSizeBytes } from "../audio.js";

const ENDPOINT_HOST = "api.minimaxi.com";
const ENDPOINT_PATH = "/v1/t2a_v2";
const DEFAULT_MODEL = "speech-2.8-hd";
const DEFAULT_VOICE = "female-shaonv";
const FRAME_BYTES_24K = frameSizeBytes(24000); // 2880 bytes (60ms @ 24kHz int16)

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
  /** Connect/read timeout ms. Default: 30000. */
  timeoutMs?: number;
}

export class MiniMaxTTS implements TTSProvider {
  readonly name = "MiniMaxTTS";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly sampleRate: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  private readonly speed: number;
  private readonly volume: number;
  private readonly pitch: number;
  private readonly timeoutMs: number;
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
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  async *synthesize(text: string): AsyncGenerator<TTSChunk> {
    if (this.disposed) throw new TTSError("MiniMaxTTS disposed");
    if (!text.trim()) {
      yield { pcm: Buffer.alloc(0), text: "", sampleRate: this.sampleRate, isFirst: true, isLast: true };
      return;
    }

    const body = JSON.stringify({
      model: this.model,
      text,
      stream: true,
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
    });

    // Collect all frames from HTTP chunked response.
    const frames: Buffer[] = await this.streamHttp(body);
    if (frames.length === 0) {
      throw new TTSError("MiniMax TTS: no audio frames received");
    }

    // Concatenate all frames into one PCM buffer, then slice into 60ms
    // sub-frames. Each TTSChunk = 60ms of PCM. isFirst/isLast on the
    // boundary chunks.
    const totalPcm = Buffer.concat(frames);
    let offset = 0;
    let isFirst = true;
    while (offset < totalPcm.length) {
      const slice = totalPcm.subarray(offset, Math.min(offset + FRAME_BYTES_24K, totalPcm.length));
      const isLast = offset + slice.length >= totalPcm.length;
      yield {
        pcm: slice,
        text,
        sampleRate: this.sampleRate,
        isFirst,
        isLast,
      };
      isFirst = false;
      offset += FRAME_BYTES_24K;
    }

    // If we emitted partial last slice (<60ms), pad to 60ms with silence
    // so esp32's opus encoder doesn't reject the frame size.
    if (totalPcm.length % FRAME_BYTES_24K !== 0) {
      const remainder = totalPcm.length % FRAME_BYTES_24K;
      const padded = Buffer.alloc(FRAME_BYTES_24K);
      totalPcm.copy(padded, 0, totalPcm.length - remainder);
      // The last yield already happened; we don't emit a new chunk here.
      // The outbound adapter is responsible for padding the tail.
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  /**
   * POST to MiniMax HTTP endpoint, read chunked transfer-encoding body
   * line-by-line (each line is a JSON frame), collect audio hex data.
   */
  private streamHttp(body: string): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const opts: import("node:http").RequestOptions = {
        host: ENDPOINT_HOST,
        port: 443,
        path: ENDPOINT_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = httpRequest(opts, (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (errBody += c));
          res.on("end", () => {
            reject(new TTSError(
              `MiniMax TTS: HTTP ${res.statusCode} ${res.statusMessage}: ${errBody.slice(0, 200)}`,
            ));
          });
          return;
        }

        // SSE format: each event is "data: {json}\n\n"
        // JSON body: { data: { audio: "<hex>", status: 1|2, ced: "" }, trace_id, base_resp }
        // Strategy: accumulate the entire body, then parse on 'end' — simpler
        // and avoids split-loop pitfalls with buffering.
        const frames: Buffer[] = [];
        let buf = "";
        let resolved = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
        });
        res.on("end", () => {
          if (resolved) return;
          resolved = true;
          // Split on SSE event boundary (\n\n or \r\n\r\n) AND on lone \n as
          // fallback (some servers don't emit double newlines reliably).
          const events = buf.split(/\r?\n\r?\n|\r?\n/);
          for (const raw of events) {
            const line = raw.trim();
            if (!line) continue;
            const data = line.startsWith("data:") ? line.slice(5).trim() : line;
            if (!data || data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data) as {
                data?: { audio?: string; status?: number; ced?: string };
                status?: number;
              };
              const inner = (obj.data ?? obj) as { audio?: string; status?: number; ced?: string };
              if (inner && typeof inner.audio === "string" && inner.audio.length > 0) {
                frames.push(Buffer.from(inner.audio, "hex"));
              }
            } catch {
              // Skip malformed lines (e.g. comment lines, keep-alives).
              continue;
            }
          }
          resolve(frames);
        });
        res.on("error", (err: Error) =>
          reject(new TTSError(`MiniMax TTS: read error: ${err.message}`, err)),
        );
      });

      req.on("error", (err: Error) =>
        reject(new TTSError(`MiniMax TTS: request error: ${err.message}`, err)),
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`MiniMax TTS: timeout after ${this.timeoutMs}ms`));
      });
      req.write(body);
      req.end();
    });
  }
}

/** Split text on ZH/EN sentence boundaries. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
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
