# openclaw-xiaozhi-plugin

> ESP32 xiaozhi 协议作为 openclaw 原生 channel plugin
>
> 替代 xiaozhi-bridge 的 6600 行 Python → ~2000 行 TypeScript
>
> openclaw 接管全部对话流程 (ASR/TTS/LLM/Memory/MCP)，plugin 只做 esp32 ↔ openclaw 翻译

[![Status](https://img.shields.io/badge/status-v0.4.0-brightgreen)](https://github.com/hqgaofeng/openclaw-xiaozhi-plugin/releases/tag/v0.4.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node 20+](https://img.shields.io/badge/node-20+-green.svg)
![TypeScript 5.4+](https://img.shields.io/badge/typescript-5.4+-blue.svg)

## 阶段状态

| 阶段 | 主题 | 状态 |
|---|---|---|
| **M3.0** | 总体规划（[docs/plan-v3-xiaozhi-plugin.md](docs/plan-v3-xiaozhi-plugin.md)）| ✅ |
| **M3.1** | SDK 调研（[docs/sdk-research-v3.md](docs/sdk-research-v3.md)）| ✅ |
| **M3.1d** | 创仓 | ✅ |
| **M3.2** | plugin 骨架 | ✅ |
| **M3.3a-c** | 加载 + dispatch + audio_params echo | ✅ |
| **M3.4a** | sherpa-onnx ASR (本地 int8) | ✅ |
| **M3.4b** | MiniMax T2A v2 TTS (HTTP+SSE) | ✅ |
| **M3.4c/d** | esp32 完整 pipeline (ASR → LLM → TTS) | ✅ |
| **M3.4g** | 配置从 ctx.cfg 读 (openclaw schema strip 修复) | ✅ |
| **M3.5** | OTA 移植 + 卸 V2 容器 + tag + 文档 | ✅ **v0.3.0** |
| **M3.6** | 记忆隔离（按设备分 user）| ⏳ |
| **M3.7** | 反向 MCP 透传 | ⏳ |

**总耗时**: 2.5 天（M3.1d → M3.5 v0.3.0 release）

## v0.3.0 release (2026-06-08)

**Feature complete**: 端到端 esp32 → STT → LLM → TTS → 喇叭播放 链路全通。

| 指标 | 状态 |
|---|---|
| TypeScript 源码 | ~2200 行 (src/) |
| 测试 | **131 passed** (vitest, 11 files) |
| TypeScript 编译 | 0 errors |
| openclaw 加载 | ✅ PID 1362601 running, port 18790 |
| OTA endpoint (`/api/xiaozhi/ota/`) | ✅ 200 OK 经公网 nginx |
| esp32 WebSocket (`/xiaozhi/v1/`) | ✅ listening |
| ASR 端到端 | ✅ sherpa-onnx int8 (中文 80%+) |
| TTS 端到端 | ✅ MiniMax T2A v2 HTTP+SSE (62 chunks × 3.67s audio in 2.2s) |
| LLM 集成 | ✅ openclaw/MiniMax-highspeed |
| V2 容器 | ❌ xiaozhi-bridge + xiaozhi-bridge-api 都已卸 |
| xiaozhi-bridge 仓 | 🏷️ `v0.2.13-legacy` tag (archival) |

## v0.4.0 release (2026-06-10) — 12 项官方对齐重构

**官方对齐**: 4 批 RC commits (`bf97051` → `38175f2` → `e10f978` → `38406c6`) + 1 批收口.
**100% 向后兼容**: 所有新功能默认关闭,通过 8 个灰度开关 opt-in,V2 链路 100% 兼容.

### 9 大新功能 (opt-in via 8 个灰度开关)

| # | 功能 | 模块 | 灰度开关 | 触发效果 |
|---|---|---|---|---|
| 1 | **Streaming TTS pipeline** | `src/ttsPipeline.ts` | `useStreamingTts` | 3-queue / 3-worker 边收边播,首包延迟 ↓ |
| 2 | **Text cleaner** (捆绑 #1) | `src/textCleaner.ts` | (随 #1 一起开) | `MarkdownCleaner` + `replace_words` + `IncrementalCleaner` |
| 3 | **Metrics module** | `src/metrics.ts` | `metricsEnabled` | `/api/xiaozhi/metrics` JSON 导出 (Counter/Histogram/Gauge) |
| 4 | **Silero ONNX VAD** | `src/vad-silero.ts` | `useSileroVad` | server-side VAD,断句准确度 ↑ |
| 5 | **Streaming ASR** | `src/asr/sherpa-onnx-streaming.ts` | `useStreamingAsr` | `OnlineRecognizer` pull-based 流式识别 |
| 6 | **PCM accumulation** | `src/inbound.ts` | `useAccumulatePcm` | opus decode 在 receive 即时,内存 ↓ |
| 7 | **Multi-flag state machine** | `src/session-flags.ts` | `useMultiFlagState` | 4 个新 flag 上 SessionContext |
| 8 | **OAuth multi-device** | `src/oauth/` | `useOAuth` | 多设备 Bearer token 验证 + store |
| 9 | **Retry helper** | `src/retry.ts` | `useRetry` | exponential backoff 包装外部调用 |

### 关键数字

| 指标 | v0.3.0 | v0.4.0 | 变化 |
|---|---|---|---|
| TypeScript 源码 | ~2200 行 | ~3000 行 | +800 (9 模块) |
| 测试 | 131 passed (11 files, v0.3.0 release) / 184 passed (15 files, 58c9afe pre-rc1) | **330 passed** (25 files) | **+146 tests / +10 files** (vs 58c9afe baseline) |
| TypeScript 编译 | 0 errors | 0 errors | = |
| 新模块 | 0 | 8 (textCleaner / ttsPipeline / metrics / vad-silero / sherpa-onnx-streaming / retry / oauth × 4) | +8 |
| 灰度开关 | 0 | 8 (opt-in only) | +8 |
| 依赖 | sherpa-onnx 1.13.2 | + `onnxruntime-node` ^1.20.0 | +1 |
| 兼容性 | — | **100% 兼容 v0.3.0** | ✓ |

### 启用示例

```jsonc
// /root/.openclaw/openclaw.json
{
  "channels": {
    "xiaozhi": {
      "useStreamingTts": true,      // batch 1 — streaming TTS + text cleaner
      "metricsEnabled": true,        // batch 2 — 暴露 /api/xiaozhi/metrics
      "useSileroVad": true,          // batch 3 — Silero ONNX VAD
      "useStreamingAsr": true,       // batch 3 — pull-based streaming ASR
      "useAccumulatePcm": true,      // batch 3 — receive-side opus decode
      "useMultiFlagState": true,     // batch 3 — 4 new flags on SessionContext
      "useOAuth": true,              // batch 4 — OAuth multi-device
      "useRetry": true               // batch 4 — retry with exponential backoff
    }
  }
}
```

**所有 flag 默认 `false` (or `undefined`)**. Allen 灰度节奏:测一项开一项,跑稳再开下一个.

## 架构

```
ESP32-S3 (xiaozhi firmware)
  │  wss://jarvis.beallen.top/xiaozhi/v1/  (WS)
  │  POST https://jarvis.beallen.top/api/xiaozhi/ota/  (OTA check)
  ▼
nginx (TLS reverse proxy, 不动)
  │  /xiaozhi/   → 127.0.0.1:18790  (WS proxy)
  │  /api/       → 127.0.0.1:18790  (HTTP proxy)
  ▼
openclaw gateway (systemd service)  ← plugin 装在 ~/.openclaw/plugins/xiaozhi/
  ├─ ChannelPlugin<XiaozhiAccount>  ← 本仓 (src/)
  │  ├─ wss server (gateway.ts)
  │  ├─ HTTP server (ota.ts, /api/xiaozhi/ota[/])
  │  ├─ ASR pipeline (sherpa-onnx WASM, src/asr/)
  │  ├─ TTS pipeline (MiniMax T2A v2, src/tts/)
  │  └─ esp32 dispatch (src/inbound.ts, src/handle/)
  ├─ agent-loop (M3 reasoning)
  ├─ Memory (按设备分 user, M3.6)
  ├─ MCP / tool router (M3.7 stub 在 mcp/inbound.ts)
  └─ providers: MiniMax T2A v2 / sherpa-onnx
```

## 已拍板决策

| # | 决策 | 答案 |
|---|---|---|
| Q1 | plugin 装在哪 | 全局（`openclaw/plugins/load.paths`）|
| Q2 | TTS | **MiniMax T2A v2**（speech-2.8-hd, female-shaonv）|
| Q3 | ASR | **sherpa-onnx** (本地 int8, bilingual zh+en)|
| Q4 | xiaozhi-bridge 仓 | **保留** + 打 `v0.2.13-legacy` tag (M3.5 ✅) |
| Q5 | M3.6+ | M3.6 记忆隔离 + M3.7 反向 MCP 透传 |
| Q6 | 1.5 个月经验 | 100% 1:1 翻译进 plugin |

## 快速开始

### 开发模式

```bash
# 1. 装依赖
npm install

# 2. 跑测试
npm test           # vitest, 330 tests (v0.4.0)
npx tsc --noEmit   # type check

# 3. build
npm run build      # → dist/

# 4. 单测覆盖
npx vitest run src/tests/test-ota.test.ts  # OTA endpoint 4 tests
```

### 装到 openclaw

```bash
# 在 openclaw.json 里:
#   plugins.load.paths = ["/root/projects/openclaw-xiaozhi-plugin"]
#   channels.xiaozhi.asr.provider = "sherpa_onnx"
#   channels.xiaozhi.tts.provider = "minimax"
#
# 触发 reload:
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.bak.v0.3.0
# (修改上面 3 处, 之后 cp bak 回来保留 v0.3.0 配置)
```

### OTA endpoint 验证

```bash
# 公网 nginx
curl -X POST https://jarvis.beallen.top/api/xiaozhi/ota/ \
  -H "Content-Type: application/json" \
  -d '{"version":2,"board":"my-custom-wifi-lcd","mac_address":"58:e6:c5:6b:9b:54","flash_size":16777216}'

# 返:
# {"websocket":{"url":"wss://jarvis.beallen.top/xiaozhi/v1/"},
#  "server_time":{"timestamp":...,"timezone":"Asia/Shanghai","timezone_offset_minutes":480},
#  "firmware":{"version":"2.2.6","url":""}}
```

## 文档

- 📐 [V3 总体架构](docs/plan-v3-xiaozhi-plugin.md) — 5 阶段路线 + 撤销清单
- 📡 [SDK 调研 + 翻译表](docs/sdk-research-v3.md) — 1.5 个月经验 ↔ openclaw SDK 1:1
- 📝 [OTA endpoint 规范](src/ota.ts) — 仿 xiaozhi-esp32 main/ota.cc

## V2 资产封存

- xiaozhi-bridge 仓保留（已打 `v0.2.13-legacy` tag, M3.5 done）
- 1.5 个月 6600 行 Python / 154 测试 / 9 份文档 — 留作 V2 资产参考
- V2 容器 (`xiaozhi-bridge` 8000, `xiaozhi-bridge-api` 8001) 都已卸
- nginx 改 `/api/` → 18790 (V3 plugin), 旧 8001 入口停

## License

[MIT](LICENSE)
