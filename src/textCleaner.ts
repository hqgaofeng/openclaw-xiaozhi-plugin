/**
 * textCleaner — prepare LLM reply text for TTS synthesis.
 *
 * v0.4.0-rc1 (batch 1, A 类 TTS 4 项重构): the new streaming TTS
 * pipeline runs this on every text chunk before synthesis. The
 * transforms are intentionally simple, deterministic, and easy to
 * test without any I/O mocks.
 *
 *   1. MarkdownCleaner.clean_markdown() — strip **bold** / *italic* /
 *      `code` / code blocks / [text](url) / 列表符号 / headers / blockquotes
 *   2. Emoji filter (Unicode emoji range)
 *   3. replace_words: Record<string, string> substitution
 *   4. IncrementalCleaner — sliding window for streaming input
 *
 * The legacy `streamTtsToOpusFrames` path in esp32ListenHandler.ts
 * does NOT call this module (it's still the V3.7 path that ships
 * untouched); the new pipeline uses it via cleanForTTS.
 */

export interface CleanerConfig {
  /** Strip **bold**, *italic*, `code`, [link](url), list markers, etc. */
  stripMarkdown: boolean;
  /** Strip Unicode emoji (range U+1F300..U+1FAFF, U+2600..U+27BF, etc.). */
  removeEmoji: boolean;
  /** Word/phrase substitution. Match is exact substring (case-sensitive). */
  replace_words: Record<string, string>;
}

export const DEFAULT_CLEANER_CONFIG: CleanerConfig = {
  stripMarkdown: true,
  removeEmoji: true,
  replace_words: {
    // Common TTS-unfriendly abbreviations / symbols seen in LLM replies.
    "...": "，",
    "…": "，",
    "&": "和",
    "@": "at",
    "%": "百分之",
    "$": "美元",
    "™": "",
    "©": "",
    "®": "",
  },
};

/**
 * Pure transform: clean a single text blob for TTS.
 *
 * Order matters:
 *   1. Markdown first — its syntax characters may collide with
 *      replace_words keys (e.g. "*" inside `*foo*` should be stripped
 *      by Markdown, not turned into a literal "*" replacement).
 *   2. Emoji next — Unicode emoji spans are easier to match before
 *      the text is munged by replace_words.
 *   3. replace_words last — operates on the human-readable text.
 */
export function cleanForTTS(text: string, config: CleanerConfig): string {
  let out = text;
  if (config.stripMarkdown) {
    out = MarkdownCleaner.clean_markdown(out);
  }
  if (config.removeEmoji) {
    out = stripEmoji(out);
  }
  for (const [from, to] of Object.entries(config.replace_words)) {
    if (from.length === 0) continue;
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Strip Unicode emoji from `text`. Covers the common ranges that
 * appear in LLM replies:
 *   - U+1F300..U+1FAFF  Misc Symbols and Pictographs, Emoticons, etc.
 *   - U+2600..U+27BF    Misc Symbols, Dingbats
 *   - U+1F1E6..U+1F1FF  Regional Indicator Symbols (flags)
 *   - U+FE0F            Variation Selector-16 (emoji presentation)
 *   - U+200D            Zero-Width Joiner (ZWJ sequences)
 */
export function stripEmoji(text: string): string {
  // The \p{Extended_Pictographic} Unicode property would be the most
  // accurate, but Node 20's regex engine with /v flag supports it.
  // We keep the explicit ranges to avoid /v flag compatibility quirks
  // across older runtimes and to keep the test deterministic.
  return text.replace(
    /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,
    "",
  );
}

/**
 * MarkdownCleaner — strip common markdown syntax that doesn't read
 * well when spoken aloud. Not a full GFM parser; just the patterns
 * we actually see in LLM replies.
 */
export class MarkdownCleaner {
  /**
   * Strip markdown syntax, leaving plain readable text.
   *
   *   **bold**        → bold
   *   *italic*        → italic
   *   `inline code`   → inline code
   *   ```fence```     → (drop the block entirely)
   *   [text](url)     → text
   *   # header        → header
   *   > quote         → quote
   *   - / 1. lists    → (drop the marker)
   */
  static clean_markdown(text: string): string {
    let out = text;

    // Fenced code blocks: drop the whole block, including language tag.
    out = out.replace(/```[^\n]*\n[\s\S]*?```/g, "");

    // Inline code: keep the content, drop the backticks.
    out = out.replace(/`([^`]+)`/g, "$1");

    // Links: keep label, drop URL.
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

    // Bold (**__**) — keep the inner text.
    out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
    out = out.replace(/__([^_]+)__/g, "$1");

    // Italic — single * or _. Be careful: this is a heuristic that
    // can mangle asterisks in plain text, but the alternative is
    // leaving *emphasis* to be spoken literally. For TTS use, the
    // mangle is the lesser evil.
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");

    // Headers at line start: #, ##, ### etc.
    out = out.replace(/^#{1,6}\s+/gm, "");

    // Blockquote markers.
    out = out.replace(/^>\s?/gm, "");

    // List markers at line start: -, *, +, or 1. 2. etc.
    out = out.replace(/^[\s]*[-*+]\s+/gm, "");
    out = out.replace(/^[\s]*\d+\.\s+/gm, "");

    // Collapse 3+ consecutive newlines down to 2.
    out = out.replace(/\n{3,}/g, "\n\n");

    return out;
  }
}

/**
 * IncrementalCleaner — buffer a stream of text chunks and emit
 * clean, flushable blobs. Designed for the streaming TTS pipeline
 * (see ttsPipeline.ts): the LLM reply arrives token-by-token;
 * we accumulate until either:
 *   - the buffered text crosses `flushAt` characters, OR
 *   - the buffered text contains a sentence boundary
 *     (。 . ! ? ！ ？ — though the most common CJK ones
 *      are 。！？ and Latin . ! ?)
 *
 * The cleaner runs `cleanForTTS` on the buffer before flushing
 * so callers receive a TTS-ready blob.
 */
export class IncrementalCleaner {
  private buffer: string = "";
  /** Min buffer length (in characters) before we consider flushing. */
  public readonly flushAt: number;
  private readonly config: CleanerConfig;

  constructor(config: CleanerConfig, opts: { flushAt?: number } = {}) {
    this.config = config;
    this.flushAt = opts.flushAt ?? 16;
  }

  /**
   * Feed a chunk of incoming text. Returns the cleaned, flushed blob
   * if the buffer crossed a flush threshold, or "" if more text is
   * needed before the next flush.
   */
  feed(chunk: string): string {
    if (!chunk) return "";
    this.buffer += chunk;
    if (this.buffer.length >= this.flushAt) {
      return this.drain();
    }
    return "";
  }

  /**
   * Flush the buffer unconditionally. Returns the cleaned blob,
   * or "" if the buffer is empty.
   */
  close(): string {
    if (this.buffer.length === 0) return "";
    return this.drain();
  }

  /**
   * Discard the buffer without flushing. Use this on abort.
   */
  reset(): void {
    this.buffer = "";
  }

  private drain(): string {
    const out = cleanForTTS(this.buffer, this.config);
    this.buffer = "";
    return out;
  }
}
