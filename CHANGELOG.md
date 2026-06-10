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

## [v0.4.0] - 2026-06-10 — 12 项官方对齐重构收口

**8 大新功能,全部 opt-in. 100% 向后兼容 v0.3.0.**

### Added

9 大新功能 (按启用顺序排列, 8 个独立灰度开关):

1. **Streaming TTS pipeline** (`src/ttsPipeline.ts`, opt-in via `useStreamingTts`)
   - 3-queue / 3-worker 架构: text → encode → send 流水线
   - 首包延迟 ↓, 边收 LLM token 边推 opus
   - Abort path: LLM 中断时清空所有 in-flight 队列
   - 13 测试 (`src/tests/test-ttsPipeline.test.ts`)
2. **Text cleaner** (`src/textCleaner.ts`, 与 #1 捆绑)
   - `MarkdownCleaner` — strip `**bold**` / `*italic*` / code fences
   - `replace_words` — 中英同义词表 (e.g. `AI` → `人工智能`)
   - `IncrementalCleaner` — sliding window 流式去重
   - 26 测试 (`src/tests/test-textCleaner.test.ts`)
3. **Metrics module** (`src/metrics.ts`, opt-in via `metricsEnabled`)
   - Counter / Histogram / Gauge 三件套 (无 Prometheus 依赖)
   - `/api/xiaozhi/metrics` JSON 导出, 禁用时返 404
   - 20 测试 (`src/tests/test-metrics.test.ts`)
4. **Silero ONNX VAD** (`src/vad-silero.ts`, opt-in via `useSileroVad`)
   - server-side VAD via `onnxruntime-node` ^1.20.0
   - 单例懒加载, 首次触发才下载模型
   - 11 测试 (`src/tests/test-vad-silero.test.ts`)
5. **Streaming ASR** (`src/asr/sherpa-onnx-streaming.ts`, opt-in via `useStreamingAsr`)
   - `OnlineRecognizer` pull-based 替代 batch transcribe
   - 边收 opus 边推 partial result
   - 16 测试 (`src/tests/test-asr-streaming.test.ts`)
6. **PCM accumulation** (`src/inbound.ts`, opt-in via `useAccumulatePcm`)
   - opus decode 在 receive 即时, 不再 buffer 整段
   - 内存占用 ↓, 首字识别延迟 ↓
   - 覆盖在 `src/tests/test-inbound.test.ts` (15 tests, 含 9 个 baseline + 6 个 `useAccumulatePcm` 用例)
7. **Multi-flag state machine** (`src/session-flags.ts`, opt-in via `useMultiFlagState`)
   - 4 个新 flag 上 `SessionContext`: wakeupPrimed / llmStreaming / ttsAbort / metricsTick
   - 15 测试 (`src/tests/test-multi-flag-state.test.ts`)
8. **OAuth multi-device** (`src/oauth/`, opt-in via `useOAuth`)
   - Bearer token 验证 (替代 V2 #6.1 单 token)
   - 多设备 store (per-device access_token / refresh_token)
   - 29 测试 (`src/oauth/__tests__/`: `test-oauth-client` 14 + `test-oauth-middleware` 6 + `test-oauth-store` 9)
9. **Retry helper** (`src/retry.ts`, opt-in via `useRetry`)
   - exponential backoff + jitter
   - 包装外部 HTTP/WS 调用 (sherpa-onnx / MiniMax)
   - 16 测试 (`src/tests/test-retry.test.ts`)

### Changed

- **version bump**: `0.3.0` → `0.4.0` (3 处一致: `package.json` / `openclaw.plugin.json` / `manifest.json`)
- **5 batch commits** (本批为收口批, 4 个 RC 此前已落):
  | batch | commit | 主题 |
  |---|---|---|
  | rc1 | `bf97051` | streaming TTS pipeline + text cleaner |
  | rc2 | `38175f2` | metrics module + 埋点 |
  | rc3 | `e10f978` | Silero ONNX VAD + ASR streaming + multi-flag state |
  | rc4 | `38406c6` | OAuth multi-device + retry helper |
  | rc5 | (this)   | version bump + README/CHANGELOG/architecture |
- **dependency**: 新增 `onnxruntime-node` ^1.20.0 (Silero VAD 依赖)
- **stage table** (README): v0.3.0 阶段状态保持, v0.4.0 阶段单独列

### Compatibility

- **100% 向后兼容 v0.3.0**: 所有新功能默认关闭, V2 链路 (mock ASR + edge TTS + 单 token auth) 行为完全一致
- **8 个灰度开关独立**: 任意子集组合启用, 互不干扰
- **现有 184 baseline tests** (从 `58c9afe` 起) 全部通过, 累积到 **330 tests** (25 files)
- **TypeScript 0 errors**, vitest 全绿, 3 处 version 字段一致

### Rollout

**批次5 (本批) 完成后需要 Allen 手动操作**:

1. **git push** (VPS 部署前):
   ```bash
   cd /root/projects/openclaw-xiaozhi-plugin
   git push origin main
   ```
2. **VPS 装新依赖** (拉 `onnxruntime-node`):
   ```bash
   cd /root/projects/openclaw-xiaozhi-plugin
   npm install
   ```
3. **Silero VAD 模型** (如启用 `useSileroVad`):
   ```bash
   mkdir -p /opt/xiaozhi-plugin/models/silero/
   # 详见 src/vad-silero.ts 顶部 model download 注释
   ```
4. **openclaw.json 灰度**:
   - 默认全 `false` / `undefined` — 跟 v0.3.0 行为一致
   - Allen 测一项开一项: `useStreamingTts` → `metricsEnabled` → `useSileroVad` → ...

### Risk

- **VPS 内存**: `onnxruntime-node` native binding 加载时会多 ~80MB, 已在 2GB swap 范围
- **Silero 模型下载**: 首次启用时需联网 (~2MB ONNX), 断网环境需手动 `scp`
- **OAuth 部署依赖**: 多设备 token store 默认 in-memory, 重启会丢; 后续接 sqlite/redis
- **Retry 副作用**: 包装 TTS HTTP 调用时, 退避可能撞上 LLM stream 的 deadline, 默认 maxRetries=3

---

## [Unreleased] - future (M3.6, M3.7, v0.5+)

### Planned for M3.6 — Per-device memory isolation
- `openclawSessionKey: "xiaozhi-${deviceId}"` 已在位
- Verify per-device memory in production (Allen-side test)
- Per-device agent prompt customization (board type → persona)

### Planned for M3.7 — Reverse MCP
- `src/mcp/inbound.ts` createEsp32ToolAdapter stub
- esp32 device tools exposed to LLM via reverse MCP
- Bidirectional tool use (LLM → esp32, esp32 → LLM)

### Planned for v0.5+
- **OAuth token store** persistence (sqlite WAL / redis)
- **Metrics** push gateway (Prometheus remote_write)
- **Streaming ASR** endpoint VAD 集成 (现 VAD 在 ASR 之后)
- **TTS pipeline** 自适应 chunk size (按网络 RTT 动态调)

---

[Unreleased]: https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/compare/v0.4.0...HEAD
[v0.4.0]: https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/compare/v0.3.0...v0.4.0
[v0.3.0]: https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/releases/tag/v0.3.0
