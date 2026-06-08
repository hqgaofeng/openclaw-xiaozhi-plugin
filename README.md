# openclaw-xiaozhi-plugin

> ESP32 xiaozhi 协议作为 openclaw 原生 channel plugin
>
> 替代 xiaozhi-bridge 的 6600 行 Python → ~2000 行 TypeScript
>
> openclaw 接管全部对话流程 (ASR/TTS/LLM/Memory/MCP)，plugin 只做 esp32 ↔ openclaw 翻译

[![Status](https://img.shields.io/badge/status-M3.1d-blue)](https://github.com/hqgaofeng/openclaw-xiaozhi-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node 20+](https://img.shields.io/badge/node-20+-green.svg)
![TypeScript 5.4+](https://img.shields.io/badge/typescript-5.4+-blue.svg)

## 阶段状态

| 阶段 | 主题 | 状态 |
|---|---|---|
| **M3.0** | 总体规划（[docs/plan-v3-xiaozhi-plugin.md](docs/plan-v3-xiaozhi-plugin.md)）| ✅ |
| **M3.1** | SDK 调研（[docs/sdk-research-v3.md](docs/sdk-research-v3.md)）| ✅ |
| **M3.1d** | 创仓 | 🚧 进行中 |
| **M3.2** | plugin 骨架（11 源文件 + 85 vitest）| ⏳ |
| **M3.3** | 本地 e2e | ⏳ |
| **M3.4** | VPS 迁移 | ⏳ |
| **M3.5** | 收口 + v0.3.0 | ⏳ |
| **M3.6** | 记忆隔离（按设备分 user）| ⏳ |
| **M3.7** | 反向 MCP 透传 | ⏳ |

**总计估时**：2.5-3 天（M3.1d → M3.5）+ 3-5h（M3.6 + M3.7）

## 已拍板决策

| # | 决策 | 答案 |
|---|---|---|
| Q1 | plugin 装在哪 | 全局（`~/.openclaw/plugins/`，npm link）|
| Q2 | TTS | **MiniMax T2A v2**（speech-2.8-hd）|
| Q3 | ASR | A1 SenseAudio（周一拿 key）+ A3 sherpa-onnx 过渡 |
| Q4 | xiaozhi-bridge 仓 | 保留 + 打 `v0.2.13-legacy` tag |
| Q5 | M3.6+ | M3.6 记忆隔离 + M3.7 反向 MCP 透传 |
| Q6 | 1.5 个月经验 | 100% 1:1 翻译进 plugin（[sdk-research-v3 §3](docs/sdk-research-v3.md)）|

## 架构

```
ESP32-S3 (xiaozhi firmware)
  │  wss://jarvis.beallen.top/xiaozhi/v1/
  ▼
nginx (TLS reverse proxy, 不动)
  │
  ▼
openclaw gateway (systemd service)  ← plugin 装在 ~/.openclaw/plugins/xiaozhi/
  ├─ ChannelPlugin<XiaozhiAccount>  ← 本仓
  ├─ agent-loop (M3 reasoning)
  ├─ Memory (按设备分 user)
  ├─ MCP / tool router
  └─ providers: M3 LLM / MiniMax T2A v2 / SenseAudio
```

## 快速开始

### 开发模式

```bash
# 1. 装依赖
npm install

# 2. 跑测试
npm test

# 3. build
npm run build
```

### 装到 openclaw

```bash
# 本地 link
npm link
openclaw plugin install openclaw-xiaozhi-plugin

# 或从 GitHub 装
openclaw plugin install github:hqgaofeng/openclaw-xiaozhi-plugin
```

## 文档

- 📐 [V3 总体架构](docs/plan-v3-xiaozhi-plugin.md) — 5 阶段路线 + 撤销清单
- 📡 [SDK 调研 + 翻译表](docs/sdk-research-v3.md) — 1.5 个月经验 ↔ openclaw SDK 1:1
- 📡 [xiaozhi 协议规范](docs/message-protocol.md) — Hello/Listen/Abort/MCP schema（**M3.2 写**）
- 🧪 [测试手册](docs/testing.md)（**M3.2 写**）

## V2 资产封存

- xiaozhi-bridge 仓保留（不打 legacy tag 之前不删）
- 1.5 个月 6600 行 Python / 154 测试 / 9 份文档 — 留作 V2 资产参考
- 计划 V3 收口时打 `v0.2.13-legacy` tag

## License

[MIT](LICENSE)
