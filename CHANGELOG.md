# Changelog

All notable changes to **openclaw-xiaozhi-plugin** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.3.0] - 2026-06-08 — M3.5 收口 release

**Feature complete end-to-end pipeline**: ESP32 → ASR → LLM → TTS → 喇叭播放.

### Added

- **OTA endpoint** (`src/ota.ts` + `src/register.ts`): xiaozhi-esp32 firmware
  POST `/api/xiaozhi/ota[/]` → returns WS URL + server time + firmware version.
  - V2 #8.1 fix preserved: NO `activation` section (triggers infinite
    loop in xiaozhi-esp32 main/ota.cc CheckVersion()).
  - Served on the same HTTP listener as the WS server (port 18790).
  - 8 KiB body limit; malformed JSON handled gracefully.
- **M3.4a sherpa-onnx ASR** (`src/asr/`): bilingual zh+en int8 model,
  pull-based decode loop, 3 V2 pitfalls baked in:
  1. int16 → float32 conversion (not int16)
  2. `modelingUnit="bpe"` + `bpeVocab` (not cjkchar)
  3. pull-based decode (`is_ready` loop) before `get_result`
- **M3.4b MiniMax T2A v2 TTS** (`src/tts/`): HTTP+SSE streaming, no
  WebSocket (the WS endpoint returns 200 not 101 upgrade).
  - 60ms-aligned PCM chunks (2880 bytes @ 24kHz int16)
  - Sentence boundary detection for ZH/EN
  - Reuses LLM's `minimax:cn` API key (zero extra key申请)
- **M3.4c/d esp32 pipeline** (`src/handle/esp32ListenHandler.ts`):
  Opus decode (16kHz) → ASR → dispatch → LLM → TTS → Opus encode (24kHz)
- **M3.4g config-from-cfg refactor**: `getXiaozhiAsrConfig()` +
  `getXiaozhiTtsConfig()` helpers in `src/api.ts` (openclaw's TypeBox
  schema validator strips undeclared fields from `ctx.account`).
- **M3.5 OTA migration**: ported V2 #8 (30-line FastAPI endpoint) to V3
  plugin via `defineBundledChannelEntry.registerFull` hook + `api.registerHttpRoute()`.

### Changed

- **nginx `/api/` → 127.0.0.1:18790** (was 8001 for V2 bridge-api).
  esp32 doesn't need re-flashing — same public URL
  `https://jarvis.beallen.top/api/xiaozhi/ota/`.
- **HTTP server unified**: same `http.createServer()` instance serves
  WS upgrade (on `account.path`) AND HTTP `/api/xiaozhi/ota[/]`. No
  second listener needed.

### Removed

- **xiaozhi-bridge container (port 8000)**: removed in P1 step 1 (pre-M3.5).
- **xiaozhi-bridge-api container (port 8001)**: removed in M3.5.
- V2 6600 LOC Python, 154 tests, 9 docs — frozen at
  [hqgaofeng/xiaozhi-bridge](https://github.com/hqgaofeng/xiaozhi-bridge)
  `v0.2.13-legacy` tag (archival reference).

### Stats

- 11 src files, ~2200 LOC TypeScript
- **131 vitest tests passing** (11 test files)
- tsc --noEmit: 0 errors
- 8+ known SDK discrepancies corrected (see [docs/sdk-research-v3.md](docs/sdk-research-v3.md))

### Verified live

- gateway PID 1362601 running
- `wss://0.0.0.0:18790/xiaozhi/v1/` listening
- `POST https://jarvis.beallen.top/api/xiaozhi/ota/` → 200 OK with
  `{"websocket":{"url":"wss://jarvis.beallen.top/xiaozhi/v1/"}, ...}`
- sherpa-onnx int8: 6.6s load + RTF 0.74 silence test
- MiniMax T2A v2: 62 chunks × 3.67s audio in 2.2s

## [Unreleased] - future (M3.6, M3.7)

### Planned for M3.6 — Per-device memory isolation
- `openclawSessionKey: "xiaozhi-${deviceId}"` already in place
- Verify per-device memory in production (Allen-side test)
- Per-device agent prompt customization (board type → persona)

### Planned for M3.7 — Reverse MCP
- `src/mcp/inbound.ts` createEsp32ToolAdapter stub
- esp32 device tools exposed to LLM via reverse MCP
- Bidirectional tool use (LLM → esp32, esp32 → LLM)

---

[Unreleased]: https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/compare/v0.3.0...HEAD
[v0.3.0]: https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/releases/tag/v0.3.0
