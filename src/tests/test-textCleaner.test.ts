/**
 * textCleaner tests — 12+ cases for MarkdownCleaner, replace_words,
 * emoji stripping, and IncrementalCleaner sliding window.
 *
 * v0.4.0-rc1: streaming TTS pipeline prep. The cleaner runs on every
 * text chunk before TTS synthesis, so unit tests need to pin down
 * the deterministic transforms (markdown → plain text, emoji removal,
 * word replacement) and the streaming boundary behavior.
 *
 * Why separate from the TTS pipeline tests: textCleaner is pure
 * (no I/O, no audio, no WS), so it can be tested without any mocks.
 */

import { describe, it, expect } from "vitest";
import {
  cleanForTTS,
  IncrementalCleaner,
  MarkdownCleaner,
  DEFAULT_CLEANER_CONFIG,
  type CleanerConfig,
} from "../textCleaner.js";

describe("DEFAULT_CLEANER_CONFIG", () => {
  it("exposes the expected shape", () => {
    expect(DEFAULT_CLEANER_CONFIG).toBeDefined();
    expect(typeof DEFAULT_CLEANER_CONFIG).toBe("object");
  });

  it("includes common TTS-unfriendly markdown punctuation filters", () => {
    // The defaults should be useful out of the box; we don't pin down
    // every entry, but a few sentinel phrases must be present.
    const defaults = DEFAULT_CLEANER_CONFIG;
    expect(defaults).toHaveProperty("replace_words");
    expect(defaults).toHaveProperty("removeEmoji");
    expect(defaults).toHaveProperty("stripMarkdown");
    expect(defaults.replace_words).toBeTypeOf("object");
  });
});

describe("cleanForTTS — emoji", () => {
  it("strips a single emoji", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, removeEmoji: true };
    expect(cleanForTTS("今天天气很好 😊", cfg)).toBe("今天天气很好 ");
  });

  it("strips a string of multiple emoji", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, removeEmoji: true };
    expect(cleanForTTS("OK 👍👍🚀", cfg)).toBe("OK ");
  });

  it("leaves emoji in place when removeEmoji is false", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, removeEmoji: false };
    expect(cleanForTTS("OK 👍", cfg)).toBe("OK 👍");
  });
});

describe("cleanForTTS — replace_words", () => {
  it("replaces a single word", () => {
    const cfg: CleanerConfig = {
      ...DEFAULT_CLEANER_CONFIG,
      replace_words: { "小智": "小助手" },
    };
    expect(cleanForTTS("你好小智", cfg)).toBe("你好小助手");
  });

  it("replaces all occurrences of a word", () => {
    const cfg: CleanerConfig = {
      ...DEFAULT_CLEANER_CONFIG,
      replace_words: { "foo": "bar" },
    };
    expect(cleanForTTS("foo and foo and foo", cfg)).toBe("bar and bar and bar");
  });

  it("supports multiple word pairs", () => {
    const cfg: CleanerConfig = {
      ...DEFAULT_CLEANER_CONFIG,
      replace_words: { "A": "X", "B": "Y" },
    };
    expect(cleanForTTS("A and B", cfg)).toBe("X and Y");
  });
});

describe("cleanForTTS — markdown", () => {
  it("strips **bold**", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    expect(cleanForTTS("**重要**的事情", cfg)).toBe("重要的事情");
  });

  it("strips *italic*", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    expect(cleanForTTS("*斜体*的文字", cfg)).toBe("斜体的文字");
  });

  it("strips `inline code`", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    expect(cleanForTTS("运行 `npm test` 试试", cfg)).toBe("运行 npm test 试试");
  });

  it("strips code fences", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    const input = "先看代码：\n```js\nconsole.log('hi')\n```\n结束了";
    const out = cleanForTTS(input, cfg);
    expect(out).not.toContain("```");
    expect(out).not.toContain("console.log");
    expect(out).toContain("结束了");
  });

  it("strips [text](url) link syntax", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    expect(cleanForTTS("访问 [官网](https://example.com) 看看", cfg)).toBe("访问 官网 看看");
  });

  it("strips leading list markers (1. / - / *)", () => {
    const cfg: CleanerConfig = { ...DEFAULT_CLEANER_CONFIG, stripMarkdown: true };
    expect(cleanForTTS("- 苹果\n- 香蕉\n- 橘子", cfg)).toBe("苹果\n香蕉\n橘子");
  });
});

describe("cleanForTTS — combined", () => {
  it("applies all transforms in one pass", () => {
    const cfg: CleanerConfig = {
      ...DEFAULT_CLEANER_CONFIG,
      removeEmoji: true,
      stripMarkdown: true,
      replace_words: { "贾维斯": "小助手" },
    };
    const input = "**贾维斯** 回答：今天 😊 晴 🌞";
    const out = cleanForTTS(input, cfg);
    expect(out).toContain("小助手");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("passes plain text through unchanged (no transforms active)", () => {
    const cfg: CleanerConfig = {
      ...DEFAULT_CLEANER_CONFIG,
      removeEmoji: false,
      stripMarkdown: false,
      replace_words: {},
    };
    expect(cleanForTTS("今天天气不错", cfg)).toBe("今天天气不错");
  });
});

describe("IncrementalCleaner", () => {
  function makeCleaner(flushAt: number): IncrementalCleaner {
    return new IncrementalCleaner(DEFAULT_CLEANER_CONFIG, { flushAt });
  }

  it("emits nothing for an input shorter than the flush threshold", () => {
    const cleaner = makeCleaner(16);
    expect(cleaner.feed("你好")).toBe("");
  });

  it("emits the buffered text once threshold is crossed", () => {
    const cleaner = makeCleaner(4);
    // "你好世界今天天气" = 8 chars, >= 4 threshold on first feed
    expect(cleaner.feed("你好世界今天天气")).toBe("你好世界今天天气");
  });

  it("accumulates across multiple feeds before flushing", () => {
    const cleaner = makeCleaner(10);
    expect(cleaner.feed("你好")).toBe("");
    expect(cleaner.feed("世界")).toBe(""); // 4 chars, still < 10
    expect(cleaner.feed("今天天气怎么样")).toBe("你好世界今天天气怎么样");
  });

  it("handles a split at a sentence boundary", () => {
    const cleaner = makeCleaner(5);
    // The flush can happen either at threshold OR at a sentence end.
    // Pin down the actual behavior: the sentence delimiter should be
    // a valid flush point.
    const first = cleaner.feed("你好世界。");
    expect(first).toContain("你好世界");
    expect(first.replace(/[。\s]/g, "")).toBe("你好世界");
  });

  it("close() flushes the remaining buffer", () => {
    const cleaner = makeCleaner(100);
    cleaner.feed("残");
    cleaner.feed("余");
    expect(cleaner.close()).toBe("残余");
  });

  it("close() on an empty buffer returns empty string", () => {
    const cleaner = makeCleaner(100);
    expect(cleaner.close()).toBe("");
  });

  it("reset() discards the buffer", () => {
    const cleaner = makeCleaner(100);
    cleaner.feed("临时");
    cleaner.reset();
    expect(cleaner.close()).toBe("");
  });
});

describe("MarkdownCleaner.clean_markdown", () => {
  it("strips headers", () => {
    expect(MarkdownCleaner.clean_markdown("# 标题\n内容")).toBe("标题\n内容");
  });

  it("strips blockquotes", () => {
    expect(MarkdownCleaner.clean_markdown("> 引用文字")).toBe("引用文字");
  });

  it("collapses triple+ newlines to double", () => {
    expect(MarkdownCleaner.clean_markdown("第一段\n\n\n\n第二段")).toBe("第一段\n\n第二段");
  });
});
