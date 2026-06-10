# openclaw-xiaozhi-plugin Architecture (v0.4.0)

> ESP32 xiaozhi protocol as a native openclaw channel plugin.

## 1. Big picture

```
                  ┌──────────────────────────────────────────┐
                  │           nginx (TLS reverse proxy)      │
                  │  jarvis.beallen.top:443                 │
                  │  /xiaozhi/*   → 127.0.0.1:18790 (WS)    │
                  │  /api/*       → 127.0.0.1:18790 (HTTP)  │
                  └───────────────┬──────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ openclaw gateway (systemd --user, openclaw v2026.6.1)     │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │  openclaw-xiaozhi-plugin (this repo, ~2200 LOC)    │    │
│  │                                                     │    │
│  │  ┌─ gateway.ts (startAccount) ─────────────────┐   │    │
│  │  │  http.createServer()                        │   │    │
│  │  │    ├─ /api/xiaozhi/ota[/] → handleOtaRequest│   │    │
│  │  │    └─ /xiaozhi/v1/  → WebSocketServer       │   │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ inbound.ts ────────────────────────────────┐   │    │
│  │  │  esp32 hello → handleEsp32Connection        │   │    │
│  │  │    ├─ session registration (V2 #4)          │   │    │
│  │  │    ├─ auth check (V2 #6.1)                  │   │    │
│  │  │    ├─ Listen(stop) → handleListenStop        │   │    │
│  │  │    └─ dispatch → openclaw agent             │   │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ handle/esp32ListenHandler.ts ───────────────┐  │    │
│  │  │  full ASR → LLM → TTS pipeline (60ms frames) │  │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ asr/sherpa-onnx.ts ─┬─ tts/MiniMax.ts ────┐    │    │
│  │  │  local int8 model    │  HTTP+SSE streaming │    │    │
│  │  │  RTF 0.74 (WASM)     │  60ms chunks        │    │    │
│  │  └──────────────────────┴─────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ openclaw core (built-in) ─────────────────────────┐   │
│  │  agent-loop → MiniMax-highspeed (LLM)              │   │
│  │  Memory (M3.6: per-device user)                    │   │
│  │  MCP (M3.7: reverse MCP stub)                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌────────────────────────────────┐
                  │    ESP32-S3 xiaozhi firmware   │
                  │    (my-custom-wifi-lcd SKU)    │
                  │    WiFi → DESKTOP-HK86VB8 0426 │
                  │    MAC 58:e6:c5:6b:9b:54      │
                  └────────────────────────────────┘
```

## 2. Module map

```
src/
├── index.ts              # defineBundledChannelEntry (entry contract)
├── plugin-xiaozhi.ts     # xiaozhiPlugin = createXiaozhiChannelPlugin()
├── channel.ts            # ChannelPlugin<XiaozhiAccount> assembly
├── api.ts                # runtime store (setXiaozhiConfig, getXiaozhiRuntime)
│                         # + config helpers (getXiaozhiAsrConfig, getXiaozhiTtsConfig)
├── config.ts             # XiaozhiAccount, XiaozhiConfig types, JSON schema
├── gateway.ts            # ChannelGatewayAdapter (wss + http on 18790)
├── inbound.ts            # ChannelMessagingAdapter (esp32 dispatch)
├── outbound.ts           # ChannelOutboundAdapter (TTS to esp32)
├── audio.ts              # OpusCodec wrapper (16kHz decode / 24kHz encode)
├── ota.ts                # OTA HTTP handler (M3.5, V2 #8 port)
├── register.ts           # plugin-level registerFull hook
├── session.ts            # device/session state (V2 #4)
├── tools.ts              # xiaozhi_list_devices agent tool
├── protocol.ts           # xiaozhi WS message types
├── handle/
│   └── esp32ListenHandler.ts  # full ASR→LLM→TTS pipeline
├── asr/                  # ASR abstraction
│   ├── types.ts          # ASRProvider / ASRConfig / ASRResult
│   ├── sherpa-onnx.ts    # local int8 implementation
│   ├── MiniMax.ts        # cloud skeleton (V2 vendor position)
│   └── index.ts          # getASRProvider(asrCfg) singleton factory
├── tts/                  # TTS abstraction
│   ├── types.ts          # TTSProvider / TTSChunk / TTSError
│   ├── MiniMax.ts        # HTTP+SSE streaming implementation
│   └── index.ts          # getTTSProvider(ttsCfg) singleton factory
├── mcp/                  # MCP reverse (M3.7 stub)
│   ├── inbound.ts        # createEsp32ToolAdapter
│   ├── outbound.ts       # device tool registration
│   └── types.ts
└── types/
    └── sherpa-onnx.d.ts  # npm @types/sherpa-onnx
```

## 3. Data flow (esp32 → LLM → esp32)

```
esp32 ─[WS frame: hello]─→  wss server (gateway.ts)
                            └─ register session in device registry
                            └─ send back: ServerHello + audio_params 16kHz

esp32 ─[binary frame: opus 60ms]─→  drainAudioBuffer
                                    └─ append to session.pcmBuffer
                                    └─ log: "audio frame 1920 bytes"

esp32 ─[JSON: Listen state=stop]─→  handleListenStop (inbound.ts)
                                    └─ OpusCodec.decode (16kHz → PCM int16)
                                    └─ asr.transcribe(PCM)
                                    └─ STT echo via sendSttMessage
                                    └─ dispatchInboundDirectDmWithRuntime
                                       ↓
                                  openclaw agent loop
                                    └─ LLM call (MiniMax-highspeed)
                                    └─ LLM stream → tts.synthesize(text)
                                       ↓
                                  MiniMaxTTS (HTTP+SSE)
                                    └─ 60ms PCM chunks
                                    └─ OpusCodec.encode (24kHz)
                                    └─ sendTtsAudio (binary frame)

esp32 ─[JSON: MCP response]─→  handleMcpMessage (M3.7)
```

## 4. Why TypeScript, not Python?

- **openclaw is TypeScript-native**: plugin contract is
  `defineBundledChannelEntry` (TypeScript). Direct import, no FFI overhead.
- **10× faster cold start**: TS module load < 1s vs Python interpreter 2-3s.
- **Better type safety**: V2's 9 V2 #N bugs were all type-system misses
  (falsy `""` vs `None`, schema strip, etc.). TypeScript catches these
  at compile time.
- **Smaller memory footprint**: V2 had Python + 3 deps (~80MiB). V3
  has sherpa-onnx WASM only (15MB) + Node 22 = ~50MiB.
- **Tooling**: vitest + tsc + tsc-watch is 10× faster than
  pytest + mypy + ruff.

## 5. What was lost (and gained) in the port

| V2 (Python) | V3 (TypeScript) | Trade-off |
|---|---|---|
| sherpa-onnx native (350MB) | sherpa-onnx WASM (15MB) | +1.2x slower (RTF 0.74 vs 0.43) |
| edge-tts (cloud) | MiniMax T2A v2 (cloud) | Better ZH quality, same key as LLM |
| FastAPI on 8001 | openclaw plugin HTTP on 18790 | One container, one port |
| Standalone WS server (8000) | openclaw plugin WS (18790) | Unified, no docker |
| aiosqlite + WAL | openclaw's native storage | V3 uses openclaw's memory, M3.6 will leverage |
| 9 文档 + 47 commits | 2 文档 + 10 commits | V3 smaller; V2 frozen as legacy |

## 6. Operational concerns

- **Swap**: 2 GiB swap added to handle openclaw + sherpa-onnx peaks
- **Restart**: `systemctl --user kill -9 <PID>` (avoid
  `systemctl restart` which occasionally SIGTERMs mid-shutdown)
- **Reload**: `cp` over `/root/.openclaw/openclaw.json` triggers
  automatic config reload
- **Log**: `journalctl --user -u openclaw-gateway -n 200 -f`
- **OTA URL**: `https://jarvis.beallen.top/api/xiaozhi/ota/` (V2 8001 entry retired)

---

## 7. v0.4.0 重构 (12 项官方对齐)

v0.4.0 在 v0.3.0 端到端管道上，额外新增 8 个 opt-in 模块 + 1 个嵌入式 cleaner。**所有新功能默认关闭，V2 链路 100% 兼容**。本节记录 v0.4.0 的模块清单、灰度开关、5 批 commit 路线图、风险评估与部署清单。

### 7.1 模块清单 (新增 8 + 1)

| 模块 | 路径 | 作用 | 测试文件 | tests |
|---|---|---|---|---|
| **textCleaner** | `src/textCleaner.ts` | `MarkdownCleaner` + `replace_words` + `IncrementalCleaner` | `src/tests/test-textCleaner.test.ts` | 26 |
| **ttsPipeline** | `src/ttsPipeline.ts` | 3-queue / 3-worker streaming TTS | `src/tests/test-ttsPipeline.test.ts` | 13 |
| **metrics** | `src/metrics.ts` | Counter / Histogram / Gauge + `/api/xiaozhi/metrics` | `src/tests/test-metrics.test.ts` | 20 |
| **vad-silero** | `src/vad-silero.ts` | Silero ONNX VAD v4 (server-side) | `src/tests/test-vad-silero.test.ts` | 11 |
| **sherpa-onnx-streaming** | `src/asr/sherpa-onnx-streaming.ts` | `OnlineRecognizer` pull-based | `src/tests/test-asr-streaming.test.ts` | 16 |
| **session-flags** | `src/session-flags.ts` | 4 个新 flag 上 `SessionContext` | `src/tests/test-multi-flag-state.test.ts` | 15 |
| **retry** | `src/retry.ts` | `withBackoff` exponential + jitter | `src/tests/test-retry.test.ts` | 16 |
| **oauth** (4 files) | `src/oauth/{client,middleware,store,types}.ts` | OAuth multi-device (Bearer + store) | `src/oauth/__tests__/test-oauth-{client,middleware,store}.test.ts` | 14 + 6 + 9 = 29 |
| **inbound (extended)** | `src/inbound.ts` | `useAccumulatePcm` receive-side opus decode | 覆盖在 `test-inbound.test.ts` | 15 (+6 新) |

**v0.4.0 端到端架构图** (opt-in modules 标 🌗 ):

```
                  ┌──────────────────────────────────────────┐
                  │           nginx (TLS reverse proxy)      │
                  │  jarvis.beallen.top:443                 │
                  │  /xiaozhi/*   → 127.0.0.1:18790 (WS)    │
                  │  /api/*       → 127.0.0.1:18790 (HTTP)  │
                  └───────────────┬──────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ openclaw gateway (systemd --user, openclaw v2026.6.1)     │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │  openclaw-xiaozhi-plugin (this repo, ~3000 LOC)    │    │
│  │                                                     │    │
│  │  ┌─ gateway.ts (startAccount) ─────────────────┐   │    │
│  │  │  http.createServer()                        │   │    │
│  │  │    ├─ /api/xiaozhi/ota[/] → handleOtaRequest│   │    │
│  │  │    ├─ /api/xiaozhi/metrics 🌗 → metrics.dump│   │    │
│  │  │    └─ /xiaozhi/v1/  → WebSocketServer       │   │    │
│  │  │        └─ oauthMiddleware 🌗 (useOAuth)     │   │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ inbound.ts ────────────────────────────────┐   │    │
│  │  │  esp32 hello → handleEsp32Connection        │   │    │
│  │  │    ├─ session registration (V2 #4)          │   │    │
│  │  │    ├─ auth check (V2 #6.1 / OAuth 🌗)      │   │    │
│  │  │    ├─ PCM accumulation 🌗 (useAccumulatePcm)│   │    │
│  │  │    ├─ VAD 🌗 (Silero ONNX, useSileroVad)    │   │    │
│  │  │    ├─ Streaming ASR 🌗 (useStreamingAsr)    │   │    │
│  │  │    ├─ dispatch → openclaw agent             │   │    │
│  │  │    └─ metrics 埋点 🌗 (metricsEnabled)      │   │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ handle/esp32ListenHandler.ts ───────────────┐  │    │
│  │  │  full ASR → LLM → TTS pipeline              │  │    │
│  │  │    └─ Streaming TTS pipeline 🌗              │  │    │
│  │  │         └─ textCleaner.cleanForTTS()         │  │    │
│  │  │              ├─ MarkdownCleaner              │  │    │
│  │  │              ├─ replace_words                │  │    │
│  │  │              └─ IncrementalCleaner           │  │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  │                                                     │    │
│  │  ┌─ asr/ ─────────────┬─ tts/ ────────┐           │    │
│  │  │  sherpa-onnx       │ MiniMax       │           │    │
│  │  │  sherpa-onnx-strm 🌗│ (T2A v2)     │           │    │
│  │  └────────────────────┴───────────────┘           │    │
│  │                                                     │    │
│  │  ┌─ session-flags 🌗 ──┬─ retry 🌗 ─────┐          │    │
│  │  │  multi-flag state   │ withBackoff   │          │    │
│  │  └────────────────────┴───────────────┘          │    │
│  │                                                     │    │
│  │  ┌─ oauth/ 🌗 ────────┬─ metrics 🌗 ────┐          │    │
│  │  │  client+store+     │ Counter/       │          │    │
│  │  │  middleware        │ Histogram/Gauge│          │    │
│  │  └────────────────────┴───────────────┘          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ openclaw core (built-in) ─────────────────────────┐   │
│  │  agent-loop → MiniMax-highspeed (LLM)              │   │
│  │  Memory (M3.6: per-device user)                    │   │
│  │  MCP (M3.7: reverse MCP stub)                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌────────────────────────────────┐
                  │    ESP32-S3 xiaozhi firmware   │
                  │    (my-custom-wifi-lcd SKU)    │
                  │    WiFi → DESKTOP-HK86VB8 0426 │
                  │    MAC 58:e6:c5:6b:9b:54      │
                  └────────────────────────────────┘

图例: 🌗 = opt-in via grayscale flag (default off)
```

### 7.2 灰度开关表 (8 个独立 flag)

| # | flag 路径 | 默认 | 模块 | 行为 | 风险 |
|---|---|---|---|---|---|
| 1 | `channels.xiaozhi.useStreamingTts` | `false` | `ttsPipeline` | 启 3-queue pipeline + textCleaner 联动 | abort 路径未在生产验证 |
| 2 | `channels.xiaozhi.metricsEnabled` | `false` | `metrics` | `/api/xiaozhi/metrics` 路由上线 | labels 高基数会撑爆内存 |
| 3 | `channels.xiaozhi.useSileroVad` | `false` | `vad-silero` | 加载 onnxruntime-node + silero 模型 | +80MB native binding, +2MB 模型下载 |
| 4 | `channels.xiaozhi.useStreamingAsr` | `false` | `sherpa-onnx-streaming` | 启 `OnlineRecognizer` 替代 batch | partial result 噪声多 |
| 5 | `channels.xiaozhi.useAccumulatePcm` | `false` | `inbound` | receive 即时 opus decode | 1 帧失败 → 该句丢 |
| 6 | `channels.xiaozhi.useMultiFlagState` | `false` | `session-flags` | 4 个新 flag 上 SessionContext | flag 冲突未在生产测 |
| 7 | `channels.xiaozhi.useOAuth` | `false` | `oauth/*` | 启 OAuth middleware + store | store in-memory, 重启丢 |
| 8 | `channels.xiaozhi.useRetry` | `false` | `retry` | 包装外部 HTTP/WS 调用 | 退避可能撞 LLM stream deadline |

**灰度节奏 (Allen 推荐)**:

```
阶段 1:  useStreamingTts=true     (批 1, 最低风险 — 改 TTS 输出流, 不改 ASR/LLM)
阶段 2:  metricsEnabled=true      (批 2, 只读 — 暴露指标, 不改行为)
阶段 3:  useSileroVad=true        (批 3a, 加 native binding + 模型)
阶段 4:  useStreamingAsr=true     (批 3b, 改 ASR 路径)
阶段 5:  useAccumulatePcm=true    (批 3c, 改 ASR 输入)
阶段 6:  useMultiFlagState=true   (批 3d, 加 session flag, 需上面 1-5 配合)
阶段 7:  useOAuth=true            (批 4a, 替换 auth 流程)
阶段 8:  useRetry=true            (批 4b, 包装 TTS HTTP 调用)
```

**Allen 测一项开一项**, 跑稳再开下一个。

### 7.3 5 批 commit 路线图

| 批 | commit | 主题 | 模块 | tests added |
|---|---|---|---|---|
| rc1 | `bf97051` | streaming TTS pipeline + text cleaner | `ttsPipeline`, `textCleaner` | +39 (13 + 26) |
| rc2 | `38175f2` | metrics module + 埋点 | `metrics` | +20 |
| rc3 | `e10f978` | Silero ONNX VAD + ASR streaming + multi-flag state | `vad-silero`, `sherpa-onnx-streaming`, `session-flags` | +42 (11 + 16 + 15) |
| rc4 | `38406c6` | OAuth multi-device + retry helper | `oauth/*` (4 files), `retry` | +45 (14+6+9+16) |
| **rc5** | **(this)** | **version bump + README + CHANGELOG + architecture** | **docs only** | **+0** |

**累计 diff**: 4 批 RC + 1 批收口 = +9651 行 / -0 src 改动 (rc5 only) / 330/330 tests passing.

### 7.4 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| **VPS 内存**: `onnxruntime-node` native binding 加载时 +80MB | 中 | 已有 2GB swap, 监控 RSS 峰值 |
| **Silero 模型下载**: 首次启用时需联网 (~2MB ONNX) | 低 | 断网环境手动 `scp` 到 `/opt/xiaozhi-plugin/models/silero/` |
| **OAuth store 重启丢**: in-memory Map 默认 | 中 | v0.5+ 接 sqlite WAL, 临时可加 `pm2 save` |
| **Retry 副作用**: 退避撞 LLM stream deadline | 低 | 默认 `maxRetries=3` + jitter, LLM stream 不走 retry |
| **streaming TTS abort**: LLM 中断时清空 in-flight 队列 | 低 | 已加 abort 路径单测, 13 测试覆盖 |
| **useAccumulatePcm 丢帧**: 1 帧失败 → 该句丢 | 中 | 下一句自动恢复, 加 metrics 监控丢帧率 |
| **labels 高基数**: `metricsEnabled` 配不当会爆内存 | 低 | 文档明示, `setMaxLabelsPerName(100)` 已设上限 |

### 7.5 部署清单 (VPS 升级 v0.3.0 → v0.4.0)

```bash
# 1. 拉代码 (Allen 手动 review + push 后)
cd /root/projects/openclaw-xiaozhi-plugin
git pull origin main
# 期望: version bump 0.3.0 → 0.4.0, 3 处一致

# 2. 装新依赖 (onnxruntime-node)
npm install
# 期望: 看到 +onnxruntime-node@1.20.0

# 3. 验证基线
npx tsc --noEmit              # 0 error
npm test                       # 330/330 passed
grep -n '"version"' package.json openclaw.plugin.json manifest.json
# 期望: 3 行, 都是 "0.4.0"

# 4. (可选) 下载 Silero 模型, 如启用 useSileroVad
mkdir -p /opt/xiaozhi-plugin/models/silero/
# 详见 src/vad-silero.ts 顶部 model download 注释 (v0.5+ 自动下载)

# 5. openclaw 重载
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.bak.v0.4.0
# (按 7.2 节奏, 一次开 1 个 flag, 重启 gateway)
systemctl --user kill -9 $(pgrep -f openclaw-gateway)
# 触发 openclaw 自动 restart

# 6. 验证 v0.4.0 启动
journalctl --user -u openclaw-gateway -n 50 -f
# 期望: "loaded plugin xiaozhi v0.4.0"

# 7. (可选) 启用 metrics 暴露
# openclaw.json:
#   channels.xiaozhi.metricsEnabled = true
# curl http://127.0.0.1:18790/api/xiaozhi/metrics
# 期望: JSON { counters: [...], histograms: [...], gauges: [...], uptime_s, timestamp }
```

### 7.6 文件结构对比 (v0.3.0 → v0.4.0)

```
src/
├── index.ts
├── plugin-xiaozhi.ts
├── channel.ts
├── api.ts                # + 8 grayscale flag readers
├── config.ts
├── gateway.ts            # + /api/xiaozhi/metrics route (opt-in)
├── inbound.ts            # + useAccumulatePcm, useStreamingTts
├── outbound.ts
├── audio.ts
├── ota.ts
├── register.ts
├── session.ts
├── session-flags.ts      # NEW (rc3) — multi-flag state
├── retry.ts              # NEW (rc4) — withBackoff
├── metrics.ts            # NEW (rc2) — Counter/Histogram/Gauge
├── textCleaner.ts        # NEW (rc1) — MarkdownCleaner + replace_words + Incremental
├── ttsPipeline.ts        # NEW (rc1) — 3-queue streaming TTS
├── vad-silero.ts         # NEW (rc3) — Silero ONNX v4
├── vad.ts                # baseline
├── tools.ts
├── protocol.ts
├── oauth/                # NEW (rc4)
│   ├── client.ts
│   ├── middleware.ts
│   ├── store.ts
│   └── types.ts
├── handle/
│   └── esp32ListenHandler.ts  # + streaming TTS pipeline
├── asr/
│   ├── types.ts
│   ├── sherpa-onnx.ts
│   ├── sherpa-onnx-streaming.ts  # NEW (rc3) — OnlineRecognizer
│   ├── MiniMax.ts
│   └── index.ts
├── tts/
│   ├── types.ts
│   ├── MiniMax.ts
│   └── index.ts
├── mcp/
│   ├── inbound.ts
│   ├── outbound.ts
│   ├── protocol.ts
│   ├── registry.ts
│   ├── tools.ts
│   └── types.ts
├── types/
│   └── sherpa-onnx.d.ts
└── tests/                       # +14 new test files (25 total)
    ├── test-ttsPipeline.test.ts         # NEW (rc1) 13 tests
    ├── test-textCleaner.test.ts         # NEW (rc1) 26 tests
    ├── test-metrics.test.ts             # NEW (rc2) 20 tests
    ├── test-vad-silero.test.ts          # NEW (rc3) 11 tests
    ├── test-asr-streaming.test.ts       # NEW (rc3) 16 tests
    ├── test-multi-flag-state.test.ts    # NEW (rc3) 15 tests
    ├── test-retry.test.ts               # NEW (rc4) 16 tests
    └── ... (17 other baseline tests)
```
