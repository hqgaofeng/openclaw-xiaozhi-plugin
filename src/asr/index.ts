/**
 * ASR provider singleton.
 *
 * M3.4: read XiaozhiAccount.asr config and instantiate the registered
 * provider on first use. Lazy-loaded to keep plugin startup fast.
 *
 * Registered providers:
 *   - "mock"                   — returns a canned string (M2 testing)
 *   - "sherpa_onnx"            — local offline Zipformer (M3.4a)
 *   - "sherpa_onnx_streaming"  — pull-based streaming Zipformer (v0.4.0-rc3)
 *   - "cloud"                  — stub for future aliyun/volcengine integration
 */

import type { ASRProvider } from "./types.js";
import { ASRError } from "./types.js";
import { SherpaOnnxASR } from "./sherpa-onnx.js";
import { SherpaOnnxStreamingASR } from "./sherpa-onnx-streaming.js";

let cachedProvider: ASRProvider | null = null;
let cachedConfigKey: string | null = null;

export interface ASRConfig {
  provider: "mock" | "sherpa_onnx" | "sherpa_onnx_streaming" | "cloud";
  options?: Record<string, unknown>;
}

export function getASRProvider(asrCfg: ASRConfig | undefined): ASRProvider {
  const cfg = asrCfg;
  if (!cfg) throw new ASRError("ASR config is not provided (channels.xiaozhi.asr in openclaw.json)");

  // Invalidate cache if config changes (plugin hot-reload)
  const key = JSON.stringify(cfg);
  if (cachedProvider && cachedConfigKey === key) {
    return cachedProvider;
  }

  // Dispose old
  if (cachedProvider) {
    cachedProvider.dispose();
    cachedProvider = null;
  }

  switch (cfg.provider) {
    case "sherpa_onnx": {
      const opts = (cfg.options ?? {}) as {
        modelDir?: string;
        numThreads?: number;
        modelingUnit?: "bpe" | "cjkchar" | "cjk_bpe" | "en_bpe" | "char" | "bpe_cn";
        bpeVocab?: string;
        preferInt8?: boolean;
      };
      if (!opts.modelDir) {
        throw new ASRError("sherpa_onnx ASR: options.modelDir is required");
      }
      cachedProvider = new SherpaOnnxASR({
        modelDir: opts.modelDir,
        numThreads: opts.numThreads,
        modelingUnit: opts.modelingUnit,
        bpeVocab: opts.bpeVocab,
        preferInt8: opts.preferInt8,
      });
      break;
    }
    case "sherpa_onnx_streaming": {
      const opts = (cfg.options ?? {}) as {
        modelDir?: string;
        numThreads?: number;
        modelingUnit?: "bpe" | "cjkchar" | "cjk_bpe" | "en_bpe" | "char" | "bpe_cn";
        bpeVocab?: string;
        preferInt8?: boolean;
      };
      if (!opts.modelDir) {
        throw new ASRError("sherpa_onnx_streaming ASR: options.modelDir is required");
      }
      cachedProvider = new SherpaOnnxStreamingASR({
        modelDir: opts.modelDir,
        numThreads: opts.numThreads,
        modelingUnit: opts.modelingUnit,
        bpeVocab: opts.bpeVocab,
        preferInt8: opts.preferInt8,
      });
      break;
    }
    case "mock": {
      cachedProvider = createMockASR();
      break;
    }
    case "cloud": {
      throw new ASRError("cloud ASR provider not yet implemented (M3.4 future)");
    }
    default: {
      throw new ASRError(`unknown ASR provider: ${(cfg as { provider: string }).provider}`);
    }
  }

  cachedConfigKey = key;
  return cachedProvider as ASRProvider;
}

export function disposeASRProvider(): void {
  if (cachedProvider) {
    cachedProvider.dispose();
    cachedProvider = null;
    cachedConfigKey = null;
  }
}

/** Mock ASR for testing — returns a fixed string. */
function createMockASR(): ASRProvider {
  let callCount = 0;
  return {
    name: "mock",
    async transcribe(_pcm) {
      callCount++;
      return { text: `[mock-asr-call-${callCount}]`, elapsedMs: 1 };
    },
    dispose() {
      callCount = 0;
    },
  };
}

export type { ASRProvider, ASRResult, PCMBuffer } from "./types.js";
export { ASRError } from "./types.js";
