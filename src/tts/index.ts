/**
 * TTS provider singleton.
 *
 * M3.4: read XiaozhiAccount.tts config and instantiate the registered
 * provider on first use. Lazy-loaded to keep plugin startup fast.
 *
 * Registered providers:
 *   - "mock"   — yields a canned silence chunk (M2 testing)
 *   - "edge"   — stub (V2 used Microsoft edge-tts, M3.4b is MiniMax)
 *   - "minimax" — MiniMax T2A v2 (M3.4b, this commit)
 *   - "cloud"  — stub for future providers
 */

import type { XiaozhiAccount } from "../config.js";
import type { TTSProvider } from "./types.js";
import { TTSError } from "./types.js";
import { MiniMaxTTS } from "./MiniMax.js";

let cachedProvider: TTSProvider | null = null;
let cachedConfigKey: string | null = null;

export function getTTSProvider(account: XiaozhiAccount): TTSProvider {
  const cfg = account.tts;
  if (!cfg) throw new TTSError("XiaozhiAccount.tts is not configured");

  // Invalidate cache if config changes (plugin hot-reload).
  const key = JSON.stringify(cfg);
  if (cachedProvider && cachedConfigKey === key) {
    return cachedProvider;
  }

  if (cachedProvider) {
    cachedProvider.dispose();
    cachedProvider = null;
  }

  switch (cfg.provider) {
    case "minimax": {
      const opts = (cfg.options ?? {}) as {
        apiKey?: string;
        model?: string;
        voice?: string;
        sampleRate?: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
        speed?: number;
        volume?: number;
        pitch?: number;
        connectTimeoutMs?: number;
      };
      cachedProvider = new MiniMaxTTS({
        apiKey: opts.apiKey,
        model: opts.model,
        voice: opts.voice,
        sampleRate: opts.sampleRate,
        speed: opts.speed,
        volume: opts.volume,
        pitch: opts.pitch,
        connectTimeoutMs: opts.connectTimeoutMs,
      });
      break;
    }
    case "mock": {
      cachedProvider = createMockTTS();
      break;
    }
    case "edge": {
      throw new TTSError("edge TTS provider not yet implemented (M3.4b uses MiniMax)");
    }
    case "cloud": {
      throw new TTSError("cloud TTS provider not yet implemented (M3.4 future)");
    }
    default: {
      throw new TTSError(`unknown TTS provider: ${(cfg as { provider: string }).provider}`);
    }
  }

  cachedConfigKey = key;
  return cachedProvider;
}

export function disposeTTSProvider(): void {
  if (cachedProvider) {
    cachedProvider.dispose();
    cachedProvider = null;
    cachedConfigKey = null;
  }
}

/** Mock TTS for testing — yields 1 silence chunk of 60ms @ 24kHz. */
function createMockTTS(): TTSProvider {
  return {
    name: "mock",
    async *synthesize(text: string) {
      // 60ms silence @ 24kHz mono int16 = 1440 samples.
      const samples = 1440;
      const pcm = Buffer.alloc(samples * 2); // zeros
      yield { pcm, text, sampleRate: 24000, isFirst: true, isLast: true };
    },
    dispose() {
      /* no-op */
    },
  };
}

export type { TTSProvider, TTSChunk } from "./types.js";
export { TTSError } from "./types.js";
