/**
 * TTS provider tests — splitSentences + mock provider + error paths.
 *
 * MiniMaxTTS itself is not tested here (would need a real api key +
 * network); the splitSentences helper and the mock provider ARE the
 * pieces that downstream code depends on, so we cover those.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getTTSProvider,
  disposeTTSProvider,
  TTSError,
  type TTSProvider,
  type TTSChunk,
} from "../tts/index.js";
import { splitSentences } from "../tts/MiniMax.js";
import type { XiaozhiAccount } from "../config.js";

function makeAccount(tts: XiaozhiAccount["tts"]): XiaozhiAccount {
  return {
    accountId: "test",
    enabled: true,
    host: "0.0.0.0",
    port: 18789,
    path: "/xiaozhi/v1/",
    tls: { enabled: false },
    authTokens: {},
    globalAuthToken: "",
    sessionIdPrefix: "xiaozhi",
    tts,
  };
}

describe("splitSentences (MiniMax T2A helper)", () => {
  it("splits on Chinese full stop 。", () => {
    expect(splitSentences("你好。今天天气真好。")).toEqual([
      "你好。",
      "今天天气真好。",
    ]);
  });

  it("splits on Chinese ！？ and English . ! ?", () => {
    expect(splitSentences("你好！今天怎么样？OK fine.")).toEqual([
      "你好！",
      "今天怎么样？",
      "OK fine.",
    ]);
  });

  it("splits on semicolons and newlines", () => {
    expect(splitSentences("第一；第二\n第三")).toEqual([
      "第一；",
      "第二",
      "第三",
    ]);
  });

  it("returns single element for text without boundaries", () => {
    expect(splitSentences("hello world")).toEqual(["hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("returns single element for whitespace-only as last-resort", () => {
    // Edge: only whitespace → fall back to whole text? We choose to
    // skip whitespace-only and return empty (caller's `if (out.length === 0)`
    // covers the "non-empty text but no boundary" case in synthesize()).
    expect(splitSentences("   ")).toEqual([]);
  });

  it("keeps trailing punctuation with the sentence", () => {
    expect(splitSentences("A。B")).toEqual(["A。", "B"]);
  });
});

describe("getTTSProvider", () => {
  beforeEach(() => disposeTTSProvider());
  afterEach(() => disposeTTSProvider());

  it("returns mock provider for provider=mock", () => {
    const p = getTTSProvider(makeAccount({ provider: "mock" }));
    expect(p.name).toBe("mock");
  });

  it("caches the same provider across calls", () => {
    const a = getTTSProvider(makeAccount({ provider: "mock" }));
    const b = getTTSProvider(makeAccount({ provider: "mock" }));
    expect(a).toBe(b);
  });

  it("invalidates cache when config changes", () => {
    const a = getTTSProvider(makeAccount({ provider: "mock" }));
    const b = getTTSProvider(
      makeAccount({ provider: "mock", options: { foo: 1 } }),
    );
    expect(a).not.toBe(b);
  });

  it("throws for unknown provider", () => {
    expect(() =>
      getTTSProvider(
        makeAccount({ provider: "weird" as unknown as "mock" }),
      ),
    ).toThrow(TTSError);
  });

  it("throws for edge provider (M3.4b uses MiniMax, edge is future)", () => {
    expect(() =>
      getTTSProvider(makeAccount({ provider: "edge" })),
    ).toThrow(/edge TTS provider not yet implemented/);
  });

  it("throws for cloud provider (future)", () => {
    expect(() =>
      getTTSProvider(makeAccount({ provider: "cloud" })),
    ).toThrow(/cloud TTS provider not yet implemented/);
  });

  it("throws for minimax without env var or apiKey", () => {
    const orig = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      expect(() =>
        getTTSProvider(makeAccount({ provider: "minimax" })),
      ).toThrow(/apiKey or MINIMAX_API_KEY env var required/);
    } finally {
      if (orig !== undefined) process.env.MINIMAX_API_KEY = orig;
    }
  });

  it("constructs MiniMaxTTS when apiKey provided in options", () => {
    const p = getTTSProvider(
      makeAccount({
        provider: "minimax",
        options: { apiKey: "test-key", voice: "male-qn-jingying" },
      }),
    );
    expect(p.name).toBe("MiniMaxTTS");
  });
});

describe("mock TTS synthesize", () => {
  let provider: TTSProvider;

  beforeEach(() => {
    provider = getTTSProvider(makeAccount({ provider: "mock" }));
  });
  afterEach(() => provider.dispose());

  it("yields one chunk with isFirst + isLast both true", async () => {
    const chunks: TTSChunk[] = [];
    for await (const c of provider.synthesize("hello")) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isFirst).toBe(true);
    expect(chunks[0].isLast).toBe(true);
    expect(chunks[0].text).toBe("hello");
    expect(chunks[0].sampleRate).toBe(24000);
  });

  it("yields 60ms of silence (1440 samples @ 24kHz)", async () => {
    const chunks: TTSChunk[] = [];
    for await (const c of provider.synthesize("test")) {
      chunks.push(c);
    }
    expect(chunks[0].pcm.length).toBe(1440 * 2); // int16 = 2 bytes/sample
    // Verify it's actually silence.
    expect(chunks[0].pcm.every((b) => b === 0)).toBe(true);
  });
});
