# V3 Plan: openclaw xiaozhi Channel Plugin (架构反转版)

> **Status**: Draft v1 (规划中, 等 Allen 拍板)
> **Author**: Jarvis (OpenClaw runtime)
> **Date**: 2026-06-05 (周五深夜起草, 周六/GMT+8 凌晨)
> **Scope**: 把 xiaozhi-bridge (Python, 6600 行) 替换为 openclaw xiaozhi-channel-plugin (TypeScript, ~2000 行)
> **Timeline**: 2.5-3 天 (M3.0 → M3.5)
> **Risk**: 中 (架构反转, 牵动整条链路; 但 openclaw 已是生产级)

---

## 0. TL;DR (Allen 60 秒阅读版)

### 0.1 这是什么

把 1.5 个月写的 xiaozhi-bridge (Python, 6600 行, v0.2.13) **整体替换**为
一个 openclaw 的 channel plugin (TypeScript, ~2000 行, 估 v0.3.0)。

- **esp32 固件不动** (xiaozhi 协议)
- **nginx 反代不动** (jarvis.beallen.top/xiaozhi/v1/)
- **XiaozhiBridgeServer.py 退场**
- **xiaozhi-bridge 仓库保留** (打 legacy tag, 不删)
- **openclaw 接管**全部对话流程 (ASR/TTS/LLM/Memory/MCP/工具)

### 0.2 解决什么 (Allen 的核心痛点)

Allen 原设想是"完全把 openclaw 当后端"——这是最干净的架构。
但 1.5 个月里我们自建了 ASR → LLM → TTS → DB 整条流水线,
把 openclaw 降级成"只是个 LLM"。这违背了 Allen 的初衷。

V3 把架构反转回来: openclaw 重新成为"对话后端",
我们只做一个薄的 channel plugin 把 esp32 翻译成 openclaw 的 channel。

### 0.3 答案速查 (Allen 拍板清单)

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| A | ASR | A1 SenseAudio (周一拿 key) + A3 sherpa-onnx 过渡 | 国内 VPS, 中文强, 已配置过 sherpa-onnx 兜底 |
| B | TTS | B2 MiniMax T2A v2 (已有 L1 key) | 中文质量 > edge, 零额外 key 申请, openclaw 已集成 |
| C | 仓库 | C1 保留 xiaozhi-bridge (打 legacy tag) | 1.5 个月代码是 V2 的资产, 便于回滚/参考 |
| D | 后续 | M3.6 记忆 (按设备分 user) + M3.7 反向 MCP 透传 | 高优, 都在 V3 范围内 |
| E | 文档 | 本文档 (30-50 KB 规划) | Allen 要求"先架构后代码" |

### 0.4 时间线

```
M3.0 (0.5d) 本文档 ─┐
M3.1 (0.5d) SDK 调研 → M3.2 (0.5d) plugin 骨架 → M3.3 (0.5d) 本地端到端
                                                          ↓
M3.5 (0.5d) 复盘 v0.3.0 ← M3.4 (0.5d) VPS 迁移
```

**总计 2.5-3 天, 5 个阶段。**

---

## 1. 现状盘点 (as-is)

### 1.1 我们现在有什么 (v0.2.13)

```
esp32 (xiaozhi WS 协议)
   ↓ wss://jarvis.beallen.top/xiaozhi/v1/
nginx (TLS 反代 :18789, :8080)
   ↓
bridge 服**务** (Python, v0.2.13, server.py 664 行 + 18 个新模块, 共 6600 行)
   ├─ XiaozhiBridgeServer (WS 握手 + 消息派发)
   ├─ asr/SenseVoice  (本地 ASR, 12 wavs 0 乱码, RTF 0.32)
   ├─ tts/edge-tts    (本地 TTS, 60ms 流式, zh-CN-XiaoxiaoNeural)
   ├─ llm/openclaw    (走 openclaw chat completions, user="xiaozhi-bridge" 写死)
   ├─ mcp/ (per-session tool manager + asyncio.Lock)
   ├─ pipeline/ (turn.py + tts.py)
   ├─ audio/ (VAD + Opus + wake-grace)
   ├─ handle/textHandler/ (官方风格的 message handler 分发)
   ├─ DB/SQLite/aiosqlite (devices, conversations, settings)
   └─ bridge-api (8080) 监控 + OTA + 鉴权
```

**代码量**: server.py 664 行 + handle/ + pipeline/ + audio/ + mcp/ + asr/ + tts/ + llm/ + DB + api/ + bridge-api ≈ 6600 行
**测试**: 147 passed + 7 skipped = 154
**CI**: 4 jobs 全绿 (ruff, mypy, pytest, docker build)

### 1.2 openclaw 现在有什么 (2026.6.1)

```
openclaw (TypeScript, 2026.6.1, npm 全局包, 14 个 channel plugin)
   ├─ Gateway (单进程, ws://0.0.0.0:18789)
   ├─ agent-loop (M3 reasoning, OpenAI 兼容)
   ├─ Memory (按 user 字段隔离, 已 live test 验证)
   ├─ MCP / tool router (14 个工**具**, plugins_func/functions/)
   ├─ 14 个 channel: telegram/matrix/signal/discord/slack/feishu/whatsapp/...
   ├─ 12 个 LLM provider: minimax/openai/gemini/coze/dify/fastgpt/ollama/...
   ├─ 14 个 TTS provider: elevenlabs/openai/microsoft edge/minimax/volcengine/...
   ├─ 4 个 ASR provider: senseaudio/azure-speech/deepgram/groq (含本地 sherpa-onnx-offline)
   ├─ 5 个 Memory provider: mem0ai/mem_local_short/mem_report_only/nomem/powermem
   ├─ SDK plugin 框架: docs/plugins/sdk-channel-plugins.md (17 字段)
   └─ 4 阶段部署: npm 全局 + systemd service + Tailscale 可选
```

### 1.3 痛点 (Allen 提的 + 我自己观察)

1. **架构走偏**: Allen 想用 openclaw 当后端, 但 1.5 个月里我们自建了 ASR/TTS/DB/MCP
2. **多份样板代码**: openclaw 已有的 12 LLM + 14 TTS + 4 ASR + 14 工具, 我**们**全**都**没**用**
3. **DB 双轨**: 我**们**的** SQLite + openclaw 内置 session store, 两套数据
4. **配置双轨**: 我**们**的** config.yaml + openclaw.json, 两份配置
5. **记忆无隔离**: 写死 `user: xiaozhi-bridge` 导致多设备记忆混乱 (V2 #37 撞过)
6. **重启易碎**: 我**们**的** service 改了 4 次, openclaw systemd unit 一行装好

### 1.4 现有 V2 资产清单 (不浪费)

| 资产 | V3 怎么用 |
|---|---|
| esp32 固件 (xiaozui) | **不动**, V3 复用 |
| nginx 反代 (jarvis.beallen.top/xiaozhi/v1/) | **不动**, V3 复用 |
| iptables-restore.service (V2 #2.2) | **不动**, V3 复用 |
| 5.4 MB data/bridge.db | **迁**到 openclaw agents/ (可**能** 丢 1.5 个月历史, **待**评估) |
| SenseVoice 模型 (200MB) | **复用** A3 过渡 (但周一切 A1 后退**役**) |
| 14 个测试 (test_v2_13_modules.py 等) | **废**, V3 改**成** plugin tests |
| 6 份文档 (README, CHANGELOG, arch, ...) | **改** v0.3.0 章节, 标 legacy |

---

## 2. 目标架构 (to-be)

### 2.1 端态图 (end state)

```
┌─────────────────────────────────────────────────────────────────┐
│  ESP32-S3 (Xiaozhi firmware)  ──不**动**──                       │
│  wss://jarvis.beallen.top/xiaozhi/v1/                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │ xiaozhi WS 协议 (Opus 帧 + JSON 文)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  nginx (TLS 反代, 不**动**)                                         │
│  jarvis.beallen.top/xiaozhi/v1/ → ws://127.0.0.1:18789           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  openclaw-xiaozhi-plugin  (NEW, 全**局**装**在** openclaw/plugins/)  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ChannelPlugin<XiaozhiAccount>  (17 字**段**实**现**)               │  │
│  │  - id: "xiaozhi"                                            │  │
│  │  - meta: { label: "Xiaozhi Device", icon: "..." }           │  │
│  │  - capabilities: { text, voice, audio, mcp, thread, ... }  │  │
│  │  - config: { wsUrl, port, tls }                             │  │
│  │  - gateway: { startAccount: wssServer, stopAccount }        │  │
│  │  - outbound: { sendText, sendTtsAudio, sendMcpCall }        │  │
│  │  - messaging: { dispatchInbound → agentLoop }               │  │
│  │  - streaming: { blockStreamingCoalesceDefaults }            │  │
│  │  - agentTools: [listDevicesTool, getDeviceInfoTool]         │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ openclaw plugin-sdk types
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  openclaw gateway  (现**成** 不**动**核**心**源**码**)                       │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐     │
│  │ agent-loop  │ session-key │ memory      │ tool-router │     │
│  │ M3 reasoning│ per device  │ user-field  │ MCP + func  │     │
│  │             │ identity    │ 记忆 (按设备)│             │     │
│  └─────────────┴─────────────┴─────────────┴─────────────┘     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ providers (现**成**)                                            │    │
│  │  - LLM: minimax M3 (我**们**已**在**用**)                              │    │
│  │  - TTS: minimax T2A v2 (speech-2.8-hd) ← 新**接**入**             │    │
│  │  - ASR: SenseAudio   (senseaudio-asr-pro-1.5) ← 新**接**入**       │    │
│  │  - VLM: minimax-VL-01 (未**来**)                                     │    │
│  │  - web_search: minimax Token Plan (未**来**)                          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                            │ 链**路**调**用**
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  VPS 18789  (openclaw systemd service)                          │
│  nginx 反代 :18789 + TLS (jarvis.beallen.top/xiaozhi/v1/ → ws) │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 替换对照表 (as-is vs to-be)

| 维度 | as-is (v0.2.13) | to-be (v0.3.0) |
|---|---|---|
| **esp32 firmware** | xiaozhi 协议 | **不动** |
| **WS 接入端** | bridge 服**务** (Python, 18789) | openclaw xiaozhi plugin (18789) |
| **ASR** | SenseVoice (本地, sherpa-onnx) | SenseAudio (云端) |
| **TTS** | edge-tts (本地, Microsoft edge) | MiniMax T2A v2 (云端) |
| **LLM** | openclaw chat completions | openclaw agent-loop (新) |
| **记忆/工具** | openclaw (有, 但 user 写死) | openclaw (按设备分 user) |
| **DB** | SQLite + aiosqlite | openclaw 内置 (agents/) |
| **配置** | config.yaml | openclaw.json |
| **监控/API** | bridge-api (8080) | openclaw control UI (web 端口 5180) |
| **OTA** | bridge-api /api/ota | openclaw plugin 提供 (或退**役**) |
| **鉴权** | bridge-api /api/devices | openclaw pairing |
| **Docker** | docker compose (3 进程) | systemd service (1 进程) |
| **代码量** | 6600 行 Python | 2000 行 TypeScript |
| **测试** | 154 个 pytest | 估 50 个 vitest |
| **CI** | 4 jobs (ruff, mypy, pytest, docker) | 1 job (vitest) |
| **运维** | 复杂 (3 容器) | 简单 (1 systemd) |

### 2.3 关键设计决策 (有证**据**链)

#### 决策 1: 全局装 vs 项目内 vs 外部仓

**选 C3 外部仓** (`hqgaofeng/openclaw-xiaozhi-plugin`)
- **理由 1**: 独立迭代速度最快, 不跟 openclaw 主仓锁版本
- **理由 2**: 可**以** PR 回 openclaw 上**游** (xioazhi 协议是 open source 的, 应该有 community interest)
- **理由 3**: 后期可**以**接**入**其他 xiaozhi 协**议**设备 (不只 esp32, 还**有** linux/windows desktop)
- **证**据**链**: SMS plugin 范**例** (`/usr/lib/node_modules/openclaw/dist/extensions/sms/`) 是**内**置**的**, 但**外**部** plugin (telegram-cli-bridge, discord-tools) 都是 npm install 模式
- **Allen 拍板**: Q1 选**全**局** (装**在** `~/.openclaw/plugins/`, **实**现**走** npm link, 不用 PR 上**游**)

#### 决策 2: TTS 用 MiniMax T2A v2 而非 Microsoft edge

**选 B2 MiniMax T2A v2**
- **理由 1**: 已有 L1 key, 不**用**重新**申**请
- **理由 2**: 中文质量明显**好**于 edge (MiniMax 是**国**内 TTS, **专**门**针对**中**文**神**经**语**音**)
- **理由 3**: openclaw 已**经**集**成** (`/usr/lib/node_modules/openclaw/dist/extensions/minimax/`), 0 配**置**
- **理由 4**: 32kHz MP3 输**出**, 高保真 (edge 是** 24kHz**)
- **证**据**链**:
  - `docs/providers/minimax.md` 全段落
  - `docs/tools/tts.md` 第一行 "MiniMax T2A v2 API"
  - openclaw dist 有 4 个 MiniMax 模块: TTS, LLM, VLM, web_search
- **Allen 拍板**: Q2 选 B2

#### 决策 3: ASR 过渡方案 (周一切 A1)

**本周**先**用 A3 sherpa-onnx-offline (本地 CLI, 复**用** V2 #10 SenseVoice 模**型**)
- **理由 1**: 模**型**已**经**挂**在** VPS `/opt/xiaozhi-bridge/models/`
- **理由 2**: 跑**通**链**路**不**要**等 key
- **理由 3**: sherpa-onnx **是** openclaw audio auto-detect 的**首**选** (docs/nodes/audio.md 段 1)
**周一** A3 退役, 切 A1 SenseAudio
- **理由 1**: 国**内** VPS, **延**迟**低**
- **理由 2**: 中文**专**项**模**型** (`senseaudio-asr-pro-1.5-260319`)
- **理由 3**: 配**置** 1 行** JSON** (`tools.media.audio.models: [{provider: "senseaudio", ...}]`)

#### 决策 4: 小记忆隔离 (M3.6 必修)

**按**设**备**分 user**: `user = f"xiaozhi-{device_id}"`
- **证**据**链**: openclaw user 字段隔**离**已** live test 验**证** (V2 #37 模**块**调**研**)
- **实**现**: plugin 在每**次** dispatch inbound 时填 `MsgContext.user = xiaozhi-${deviceId}`
- **风**险**: 跨**设**备**不**同**记**忆** (但**这**是**预**期**行**为**, 符合 ESP32 物**理**设**备**语义)

#### 决策 5: 反**向** MCP 透**传** (M3.7 必修)

**esp32 上**的**工具** (灯**光**、**开**关**、**传**感**器**) 透**到** openclaw tool router
- **当**前** V2 #7 已**经**实**现** JSON-RPC 2.0 (server.py _handle_mcp), V0.2.11 commit ce7a328
- **V3 实**现**: plugin 把 esp32 上**报**的**工**具**包**装**成** openclaw agent tool, 注**册**到 `agentTools: [...]`
- **可**借**鉴**: openclaw `unified_tool_manager.py` (200+ 行, 派**发**器) + `device_mcp/mcp_handler.py` (MCPClient, 403 行)

---

## 3. SDK 调研成果 (M3.0 阶段产出)

### 3.1 ChannelPlugin 主类型 (17 字段)

```typescript
// /usr/lib/node_modules/openclaw/dist/plugin-sdk/types.public-CsG15_M2.d.ts:9-46
type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;                                        // "xiaozhi"
  meta: ChannelMeta;                                    // { label, icon, ... }
  capabilities: ChannelCapabilities;                    // { text, voice, audio, mcp, ... }
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  setupWizard?: ChannelPluginSetupWizard;
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gatewayMethods?: string[];
  gatewayMethodDescriptors?: ChannelGatewayMethodDescriptor[];
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;    // ★ 启**动**服**务** (startAccount)
  auth?: ChannelAuthAdapter;
  approvalCapability?: ChannelApprovalCapability;
  elevated?: ChannelElevatedAdapter;
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  allowlist?: ChannelAllowlistAdapter;
  doctor?: ChannelDoctorAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  streaming?: ChannelStreamingAdapter;                 // ★ 流**式**配**置**
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelMessagingAdapter;                 // ★ 入**站**派**发**到** agent
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];  // ★ esp32 工**具**注**册**
};
```

### 3.2 4 个核心 adapter 接**口**形状

#### 3.2.1 ChannelGatewayAdapter (startAccount)

```typescript
// types.adapters-5-zlux7w.d.ts
type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => string[];
  loginWithQrStart?: (params: { accountId?: string; force?: boolean; ... }) => Promise<...>;
  loginWithQrWait?: (params: { accountId?: string; timeoutMs?: number; ... }) => Promise<...>;
  logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
};
```

**SMS plugin 范例** (`dist/extensions/sms/channel-plugin-api.js`):
```javascript
async function startSmsGatewayAccount(params) {
  if (!params.account.enabled) {
    params.log?.info?.(`SMS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectSmsStartupWarnings(params.account);
  // ... 警告处理
  const unregister = registerSmsWebhookRoute(params);
  params.log?.info?.(`Registered SMS webhook route ${params.account.webhookPath}`);
  return waitUntilAbort(params.abortSignal, unregister);
}
```

**我们实**现** (伪代码)**:
```typescript
async function startXiaozhiGatewayAccount(ctx) {
  // 1. 启**动** wss://0.0.0.0:18789/xiaozhi/v1/ 服**务**
  const server = await startXiaozhiWsServer({
    cfg: ctx.cfg,
    account: ctx.account,
    abortSignal: ctx.abortSignal,
    log: ctx.log,
  });
  // 2. 绑**定** esp32 验**证** + 路**由**到** agent loop
  // 3. wait until abort
  return waitUntilAbort(ctx.abortSignal, () => server.close());
}
```

#### 3.2.2 ChannelMessagingAdapter (入**站**派**发**)

```typescript
// types.core-synVrH0Z.d.ts
type ChannelMessagingAdapter = {
  targetPrefixes?: readonly string[];                  // ["xiaozhi:esp32-58e6c56b9b54"]
  normalizeTarget?: (raw: string) => string | undefined;
  defaultMarkdownTableMode?: MarkdownTableMode;
  normalizeExplicitSessionKey?: (params: { sessionKey: string; ctx: MsgContext }) => string | undefined;
  deriveLegacySessionChatType?: (sessionKey: string) => "direct" | "group" | "channel" | undefined;
  // ... 14 个**方**法**
};
```

#### 3.2.3 ChannelOutboundAdapter (出**站**返**回** esp32)

```typescript
// outbound.types-CLmrfAQv.d.ts
type ChannelOutboundAdapter = {
  sendText?: (params: { ... }) => Promise<OutboundDeliveryResult>;
  sendMedia?: (params: { ... }) => Promise<OutboundDeliveryResult>;
  sendTtsAudio?: (params: { audio: Buffer; text: string; ... }) => Promise<OutboundDeliveryResult>;
  // ...
};
```

#### 3.2.4 ChannelStreamingAdapter (流**式**音**频**)

```typescript
type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: { minChars: number; idleMs: number };
};
```

### 3.3 telegram plugin 实**现**形态 (参**考**对**象**)

**目录**:
```
/usr/lib/node_modules/openclaw/dist/extensions/telegram/
├── account-inspect-api.d.ts
├── channel-config-api.d.ts      # ★ ChannelConfigAdapter 实**现**
├── runtime-api.d.ts              # ★ ChannelGatewayAdapter 实**现**
├── runtime-setter-api.d.ts
├── setup-plugin-api.d.ts
├── ...
└── send-BTL0AC25.js              # 出**站**发**送** (sendMessageTelegram, sendSticker, sendPoll, ...)
```

**关**键** API 暴**露** (runtime-api.js 第 3 行):
```javascript
export { sendMessageTelegram, sendStickerTelegram, sendPollTelegram, sendTypingTelegram, ... };
```

**Plugin 形**状** (从 SMS 学**到**的)**:
```typescript
// 1. manifest.json
{
  "id": "xiaozhi",
  "name": "Xiaozhi Device Channel",
  "main": "dist/index.js",
  "openclaw": { "minVersion": "2026.6.0" }
}

// 2. src/index.ts
import { createXiaozhiChannelPlugin } from "./channel.js";
export default createXiaozhiChannelPlugin();

// 3. src/channel.ts
export function createXiaozhiChannelPlugin(): ChannelPlugin<XiaozhiAccount> {
  return {
    id: "xiaozhi" as ChannelId,
    meta: { label: "Xiaozhi Device", icon: "..." },
    capabilities: { text: true, voice: true, audio: true, mcp: true },
    config: createXiaozhiConfigAdapter(),
    gateway: createXiaozhiGatewayAdapter(),
    messaging: createXiaozhiMessagingAdapter(),
    outbound: createXiaozhiOutboundAdapter(),
    streaming: { blockStreamingCoalesceDefaults: { minChars: 50, idleMs: 200 } },
    agentTools: [createListDevicesTool(), createGetDeviceInfoTool()],
  };
}
```

### 3.4 xiaozhi 协**议** 翻**译**表 (从 esp32 协**议**到** openclaw)

| esp32 消**息** | xiaozhi 文**档** | openclaw 对**应** | 翻**译**逻辑 |
|---|---|---|---|
| `Hello` (audio_params + features) | core/handle/helloHandle.py | `MsgContext` + `Body=""`  | 解**析**音**频**格**式** + 创**建** session |
| `Listen` (mode=start/stop) | textHandler/listenMessageHandler.py | `MsgContext` (audio binary) | binary 帧 → `MsgContext.media[]` |
| `Abort` | textHandler/abortMessageHandler.py | `runtime.cancelTurn` | 调**用** openclaw abort |
| `MCP` (JSON-RPC 2.0) | textHandler/mcpMessageHandler.py | `agentTools.dispatch` | esp32 工**具**注**册**为** openclaw tool |
| `IOT` (设备状态) | textHandler/iotMessageHandler.py | `MsgContext.body` (text) | 翻**译**为**文**本**对**话** |
| `Ping` (keepalive) | textHandler/pingMessageHandler.py | keepalive frame | 转**发**到** nginx |
| 出**站** `TTS` (start/sentence/audio/stop) | sendAudioHandle.py | outbound.sendTtsAudio | TTS 音**频**帧**流 |
| 出**站** `STT` (text result) | receiveAudioHandle.py | inbound.transcript | ASR 完**成**后**的**文**本** |

---

## 4. 5 阶段实施路线 (M3.0 → M3.5)

### 4.1 M3.0: 总体规划 (本**文**档**) — 0.5 天

**产**出**:
- `docs/plan-v3-xiaozhi-plugin.md` (本**文**档**, 30-50 KB)
- GitHub Issue: V3 阶**段**总**览** (Allen 拍**板**后**开**)

**验**证**: Allen 拍**板** A/B/C/D/E 5 个**问**题**

### 4.2 M3.1: SDK 调**研** + telegram plugin 仿**写** — 0.5 天

**读**的**文**档**:
- `docs/install/development-channels.md` (channel 接**入**概**念**)
- `docs/plugins/sdk-channel-plugins.md` (plugin SDK)
- `docs/plugins/sdk-channel-outbound.md` (出**站**接**口**)
- `docs/plugins/sdk-channel-ingress.md` (入**站**接**口**)
- `dist/plugin-sdk/types.public-CsG15_M2.d.ts` (ChannelPlugin 17 字**段**)

**读**的**例**子**:
- `dist/extensions/sms/channel-plugin-api.js` (startAccount 范**例**)
- `dist/extensions/telegram/` (完**整**的**出**站**实**现**)
- `dist/extensions/minimax/` (M2.7 / T2A v2 接**入**)

**摸**清** 4 件**事**:
1. esp32 **作**为**一**个** "**设**备**"**接**入** openclaw 的**命**名**空**间**叫**什**么** (类**似** `telegram:123`)
2. xiaozhi 协**议**的** "** text message **"** 怎**么**包**装**成** openclaw **入**站**的** text message (Body 字**段**)
3. esp32 **收**到**的** xiaozhi **二**进**制**音**频** 怎**么**走** `tools.media.audio.models` (ASR **路**径**)
4. openclaw **出**站**的** "**TTS audio **"** 怎**么**翻**译**成** xiaozhi tts 消**息** (server→client JSON)

**产**出**:
- `docs/sdk-research-v3.md` (调**研**笔**记**)
- `openclaw-xiaozhi-plugin/` (仓**库**初**始**化**)

### 4.3 M3.2: xiaozhi-channel-plugin 骨**架** — 0.5 天

**一**个**最**小**可**用**的** plugin** (估** ~500-700 行** TypeScript**)**:

```
openclaw-xiaozhi-plugin/
├── package.json
├── README.md
├── tsconfig.json
├── vitest.config.ts
├── manifest.json                 # plugin 元**数**据**
├── src/
│   ├── index.ts                  # 出**口** (createXiaozhiChannelPlugin)
│   ├── channel.ts                # 主 ChannelPlugin 装**配** (17 字**段**)
│   ├── config.ts                 # ChannelConfigAdapter + XiaozhiAccount
│   ├── gateway.ts                # ChannelGatewayAdapter (startXiaozhiGatewayAccount)
│   ├── inbound.ts                # esp32 WS 服**务** + 消**息**派**发**到** openclaw
│   ├── outbound.ts               # openclaw → esp32 (TTS, MCP, text)
│   ├── protocol.ts               # xiaozhi WS 消**息**类**型** (Hello/Listen/Abort/MCP/IOT)
│   ├── audio.ts                  # Opus ↔ PCM 互**转** (如**果** A3 过渡**用**)
│   ├── session.ts                # device_id → session_key 映**射**
│   ├── tools.ts                  # 2-3 个** openclaw agent tool (list_devices/get_device_info)
│   └── tests/
│       ├── test-config.ts
│       ├── test-gateway.ts
│       ├── test-inbound.ts
│       ├── test-outbound.ts
│       └── test-protocol.ts
```

**最**小**能**跑**的**功**能**:
- esp32 `Hello` 消**息** → 创**建** openclaw session (key=`xiaozhi-{deviceId}`)
- esp32 `Listen` 音**频** → 写**入** openclaw audio queue (auto-detect ASR)
- openclaw **回**复** text → 发**送** esp32 `tts` 消**息**
- esp32 `tts` 消**息** 收**到**音**频** 帧** → 接**着** TTS stream 推

**产**出**:
- 可**以**用** `openclaw plugin install /path/to/openclaw-xiaozhi-plugin` 装**上**的** plugin
- `openclaw doctor` 检**查**过**
- 5 个**单**元**测**试**过**

### 4.4 M3.3: 本**地**端**到**端**联**调** — 0.5 天

**本**地**开** openclaw** + esp32 烧**入**固**件**配**网**:
1. `cd openclaw-xiaozhi-plugin && npm install && npm run build`
2. `openclaw plugin install .`
3. 配**置** `~/.openclaw/openclaw.json`:
   ```json5
   {
     channels: {
       xiaozhi: {
         enabled: true,
         port: 18789,
         tls: { cert: "...", key: "..." }  // 本**地**可**省**略
       }
     },
     tools: { media: { audio: { enabled: true, models: [{ provider: "sherpa-onnx-offline", ... }] } } },
     messages: { tts: { auto: "always", provider: "minimax" } }
   }
   ```
4. `openclaw gateway start` (背**景**跑)
5. `curl ws://127.0.0.1:18789/xiaozhi/v1/` 验**证** wss 端**点**
6. esp32 烧**入**固**件**, 配**网** `Xiaozhi-XXXX`, 配**置** ws://本**机**IP:18789
7. 说** "**你**好**小**智**"** → 验**证**回**复** + 听** TTS**

**产**出**:
- 本**地**端**到**端**测**试**通**过**
- 录**屏** + 日**志** 存**档**

### 4.5 M3.4: VPS 迁**移** + 验**证** — 0.5 天

**VPS** 上**装** plugin** (全**局**)**:
1. SSH racknerd-b9486c0 (OpenClaw 本**机**, 不**用** SSH 远**程**)
2. `cd ~/openclaw-xiaozhi-plugin && npm install && npm run build`
3. `openclaw plugin install .` (装**到** `~/.openclaw/plugins/xiaozhi/`)
4. **修**改** `~/.openclaw/openclaw.json`** 加** xiaozhi 配置
5. `systemctl restart openclaw` (不**破**坏** iptables-restore.service)
6. nginx 反**代**已**经**配**置**好** `jarvis.beallen.top/xiaozhi/v1/` → 不**动**
7. esp32 OTA **升**级** ws URL 改**成** `wss://jarvis.beallen.top/xiaozhi/v1/`
8. 配**网** + 说** "**你**好**小**智**"** → 验**证**全**链**路**

**产**出**:
- VPS `/api/health` 返** `version: 0.3.0`
- esp32 实**物**接**入**成**功** (说**话**有**回**复**)
- TTS 音**质** 验**证** (MiniMax T2A v2 vs edge)

### 4.6 M3.5: 收**尾** + 复**盘** v0.3.0** — 0.5 天

**撤**销**清单**:
- [ ] **停** docker compose (bridge 服**务** 3 容器)
- [ ] **卸**载** nginx location `/xiaozhi/v1/`** (或**者**改**为**转发**到** openclaw 18789, 一**致**)
- [ ] **打** tag: `xiaozhi-bridge v0.2.13-legacy` (标**记**为** legacy)
- [ ] **保**留** xiaozhi-bridge 仓**库** (不**删**)
- [ ] **转**移** `data/bridge.db`** (如**果**要**保**留**历**史**, 写** migration 脚**本**; 否**则**丢**弃**)

**文**档**更**新**:
- [ ] README.md: 加 v0.3.0 一**行** (架**构**反**转**版)
- [ ] CHANGELOG: 加 v0.3.0 大**段**
- [ ] architecture.md: 重**画**架**构**图** (这**个**新**文**档**就**是** v3 架**构**)
- [ ] plan-v3-xiaozhi-plugin.md (本**文**档**) 移**到** `docs/archive/` (标**记**完**成**)
- [ ] MEMORY.md §4.39: V3 架**构**反**转** 5 阶**段**实**施**复**盘**

**v0.3.0 tag** + push**:
- [ ] v0.3.0 commit: xiaozhi-bridge 打 legacy tag (不**推** v0.3.0 到 xiaozhi-bridge, 那**是** plugin 的**版**本**)
- [ ] v0.3.0 tag on openclaw-xiaozhi-plugin: 推到** GitHub

**总**复**盘**:
- [ ] 本**次**新**增**几**行** plugin 代**码**?
- [ ] 删**了**几**行** bridge 代**码**?
- [ ] 端**到**端**延**迟** 比** V0.2.13 怎**么**样**?
- [ ] TTS 音**质** 怎**么**样**?
- [ ] 记**忆** 按**设**备**隔**离**了**吗**?
- [ ] 反**向** MCP 工**具** 透**传**了**吗**?
- [ ] 周**一** SenseAudio key **到**了**怎**么**切**?

---

## 5. 风**险**清**单** (5 项)

### 5.1 风**险** 1: xiaozhi 协**议**未**文**档**化**部**分** (中)

- **症**状**: esp32 固**件**有**些**消**息**类**型**没**有**官**方**文**档** (e.g. IOT 消**息** 详**细**格**式**)
- **应**对****: 读** xiaozhi-esp32-server 源**码** (`/root/xiaozhi-esp32-server/main/xiaozhi-server/core/handle/`) 摸**清**每**个**消**息**类**型**
- **降**级**: 哪**个**消**息**类**型**摸**不**清**就**先**不**实**现**, esp32 触**发**就** warn + skip

### 5.2 风**险** 2: 音**频**流**式** ASR 延**迟** (低-中)

- **症**状**: SenseAudio 是**批**量** STT, 等**整**段**音**频**才**返**回**文**本**, 不**能**实**时**显**示**
- **应**对****: 本**周**用** sherpa-onnx-offline (本**地**, **实**时**); 周**一**切** SenseAudio **后**加** VAD 触**发** "**停**止**后**才** ASR"
- **降**级**: 如**果** SenseAudio 延**迟** > 3s, 切** Azure Speech (流**式**)

### 5.3 风**险** 3: 反**向** MCP 工**具**透**传**失**败** (中)

- **症**状**: esp32 上**报**的**工**具** (灯**、**开**关**) 怎**么**注**册**为** openclaw agent tool
- **应**对****: V2 #7 已**经**实**现** JSON-RPC 2.0 (V0.2.11 commit ce7a328), V0.2.13a mcp/ 重**构** 已**经**抽**出** MCPClient
- **降**级**: M3.7 **先**做** "**工**具**列**表**透**传**"** (列**出** esp32 工**具** 不**真**接**调**用**), V3.1 再**做** "**透**传**调**用**"

### 5.4 风**险** 4: 记**忆**迁**移**丢**数**据** (低)

- **症**状**: 1.5 个**月** 的**对**话**记**录** (5.4 MB bridge.db) 迁**到** openclaw agents/ **有**可**能**丢**
- **应**对****: 先**写** migration 脚**本** (`scripts/migrate_bridge_db_to_openclaw.py`), 转**换**对**话**记**录**为** openclaw session store 格**式**
- **降**级**: 如**果** migration **复**杂**度** > 4 hr, **丢**弃**历**史** (新**系**统**从**零**开**始**)

### 5.5 风**险** 5: openclaw 升**级**不**兼**容** (中)

- **症**状**: openclaw 升**级**到** 2026.6.2+ 可**能**改** plugin SDK 17 字**段**的**形**状
- **应**对****: pin openclaw 版本**在** 2026.6.1 (仓**库**写**到** package.json)
- **降**级**: openclaw 升**级**时**跟**着**修** plugin, 用** `npm test` 验**证**

---

## 6. 测**试**策**略** (3 段)

### 6.1 阶**段** 1: 单**元**测**试** (plugin 内**部**)

- **vitest** 测**试** `src/{gateway,inbound,outbound,protocol,audio,session,tools}/*.ts`
- **目**标**覆**盖**率**: 80%+
- **范**例**测**试**:
  - `test-protocol.ts`: xiaozhi `Hello` 消**息** 解析**正**确** (audio_params + features)
  - `test-inbound.ts`: esp32 `Listen` 音**频** 帧** 派**发**到** openclaw audio queue
  - `test-outbound.ts`: openclaw TTS 音**频** 翻**译**为** xiaozhi tts 消**息**
  - `test-session.ts`: device_id → session_key 映**射** 一**致**
  - `test-tools.ts`: esp32 工**具** 注**册**为** openclaw agent tool
- **预**估**: 50 个** vitest 用**例**

### 6.2 阶**段** 2: 本**地**端**到**端** (本**地**开**开**发**机**)

- `openclaw gateway start` + `openclaw doctor`
- 本**地** WS 客**户**端** (`wscat ws://127.0.0.1:18789/xiaozhi/v1/`) 发** Hello + Listen (mock 音**频**)
- 验**证** openclaw log + openclaw session store + openclaw tool router

### 6.3 阶**段** 3: VPS 端**到**端** (esp32 实**物**)

- VPS **部**署** plugin** (M3.4)
- esp32 **烧**入**固**件**, 配**网**
- 说** "**你**好**小**智**"** → 听**回**复**
- 验**证**记**忆**隔**离** (不**同** esp32 记**忆**不**同**)
- 验**证**反**向** MCP (esp32 报**工**具** → LLM 能**调**)

---

## 7. 撤**销**清**单** (1 表**看**完**)

| 资**产** | V2 用**于** | V3 怎**么**办** | 操**作** |
|---|---|---|---|
| esp32 固**件** (xiaozhi 协**议**) | 链**路**客**户**端** | **不**动** | 升**级** ws URL 为** `wss://jarvis.beallen.top/xiaozhi/v1/` |
| nginx 反**代** (jarvis.beallen.top) | TLS + 反**代** | **不**动** (或**者**改**为**转发**到** 18789) | 修**改** upstream |
| iptables-restore.service | iptables 持**久**化 | **不**动** | - |
| SenseVoice 模**型** (200MB) | V2 ASR | A3 过渡**用** (周**一**后退**役**) | 周**一**后**卸**载** |
| data/bridge.db (5.4 MB) | 历**史**对**话** | **迁**移**到** openclaw agents/ (4 hr) **或**丢**弃** | 决**策**后**写** migration 脚**本** |
| 14 个**测**试** (pytest) | V2 验**证** | **废**, 改** vitest** | 删** tests/ |
| 6 份**文**档** (README, CHANGELOG, arch, ...) | V2 文**档** | **改** v0.3.0 章**节**, 标 legacy | 改** 6 份**文**档** |
| bridge Dockerfile | V2 镜**像** | **废** | 不**再** build |
| docker-compose.yml | V2 部**署** | **废** | 不**再** deploy |
| bridge 服**务** (3 容**器**) | V2 运**行** | **停**服**务** | `docker compose down` |
| bridge-api (8080) | V2 监**控** + OTA + 鉴**权** | **废** | 用** openclaw control UI (5180) |
| 13 个** Py** 模**块** (asr/tts/llm/mcp/...) | V2 业**务** | **废** | **删** 6600 行** Py** |
| server.py (664 行**) | V2 服**务**主**循**环** | **废** | **删** |

---

## 8. 后**阶**段**规**划** (M3.6+)

### 8.1 M3.6 记**忆**修**改** (按**设**备**分** user) — 2-3 hr

**实**现**位**置**: `openclaw-xiaozhi-plugin/src/inbound.ts` 的** `dispatchInboundToAgent` **方**法**

**伪代**码**:
```typescript
async function dispatchInboundToAgent(ctx: XiaozhiContext, msg: XiaozhiMessage) {
  const sessionKey = `xiaozhi-${ctx.deviceId}`;  // ★ 关键修改
  const msgContext: MsgContext = {
    Body: msg.text || "",
    From: ctx.deviceId,
    To: sessionKey,
    SessionKey: sessionKey,
    // ... 音**频**附**件**、MCP 消**息**等
  };
  return ctx.channelRuntime.dispatch(msgContext);
}
```

**验**证**:
- esp32 A 说** "**我**叫** A1**"** + 后**续**问** "**我**叫**什**么**"** → A1 记**住**
- esp32 B 说** "**我**叫** B1**"** + 后**续**问** "**我**叫**什**么**"** → B1 记**住**
- 跨**设**备** 不**混**杂** (A1 不**会**记**住** B1)

### 8.2 M3.7 反**向** MCP 透**传** (esp32 工**具** → openclaw tool router) — 1-2 hr

**实**现**位**置**: `openclaw-xiaozhi-plugin/src/tools.ts`

**伪代**码**:
```typescript
export function createListDevicesTool(): ChannelAgentTool {
  return {
    name: "xiaozhi_list_devices",
    description: "List all connected ESP32 devices",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const devices = await ctx.deviceStore.list();
      return JSON.stringify(devices);
    },
  };
}
```

**esp32 上**报**工**具**后**, plugin 动**态**创**建** tool:
```typescript
// 在 inbound.ts 监**听** esp32 MCP 列**表**消**息**
async function onMcpToolsList(ctx: XiaozhiContext, tools: McpTool[]) {
  for (const tool of tools) {
    ctx.agentTools.push(createEsp32ToolAdapter(ctx, tool));
  }
}
```

**验**证**:
- esp32 上**报**工**具** `set_led_color` (颜色)
- LLM 调**用** `set_led_color("blue")` → esp32 收**到** JSON-RPC
- 灯**真**的**变**蓝**色**

---

## 9. 答**案**记**录** (Allen 拍**板**)

| # | 问**题** | 答**案** | 拍**板**日**期** |
|---|---|---|---|
| Q1 | plugin 装**在**哪**？** | 全**局** (装**在** `~/.openclaw/plugins/`) | 2026-06-05 |
| Q2 | TTS 用**哪**个**？** | MiniMax T2A v2 (speech-2.8-hd) | 2026-06-05 |
| Q3 | ASR 用**哪**个**？** | A1 SenseAudio (周**一**拿** key) + A3 sherpa-onnx 过**渡** | 2026-06-05 |
| Q4 | 是**否**保**留** xiaozhi-bridge 仓**库**？** | 保**留** (打 legacy tag) | 2026-06-05 |
| Q5 | M3.6+ 做**什**么**？** | M3.6 记**忆** (按**设**备**分** user) + M3.7 反**向** MCP 透**传** | 2026-06-05 |

---

## 10. 最**后**一**句**

**Allen 这**个**总**体**规**划**就**是** V3 的**路**线**图**。**我**没**写**任**何**代**码**。**只**有** 1 份**文**档**。**等**你**说** "**开**干**"**，**我**就**按** M3.0 → M3.5 顺**序**走**。**

**或**你**要**先**修**改**某**一**段** (比**如**估**时**偏**长**、**风**险**漏**了**、**某**个**阶**段**顺**序**调**整**)**，**我**就**改**。**

---

## 附**录** A: 参**考**文**档**清**单**

### A.1 openclaw 官**方**文**档**

- `docs/install/development-channels.md`
- `docs/plugins/sdk-channel-plugins.md`
- `docs/plugins/sdk-channel-outbound.md`
- `docs/plugins/sdk-channel-ingress.md`
- `docs/tools/tts.md` (14 个** TTS provider)
- `docs/nodes/audio.md` (入**站**音**频**识**别**管**道**)
- `docs/nodes/talk.md` (实**时**对**话**模**式**)
- `docs/providers/minimax.md` (T2A v2 + LLM + VLM)
- `docs/providers/senseaudio.md` (ASR)
- `docs/concepts/agent-loop.md` (chat 流**程**入**门**)
- `docs/concepts/channel-docking.md` (channel 切**换**)

### A.2 openclaw SDK 源**码**

- `dist/plugin-sdk/types.public-CsG15_M2.d.ts` (ChannelPlugin 17 字**段**)
- `dist/plugin-sdk/types.adapters-5-zlux7w.d.ts` (4 个**核**心** adapter)
- `dist/plugin-sdk/outbound.types-CLmrfAQv.d.ts` (出**站**接**口**)
- `dist/plugin-sdk/index.d.ts` (SDK 总**出**口**)

### A.3 openclaw plugin 范**例**

- `dist/extensions/sms/` (startAccount 范**例**)
- `dist/extensions/telegram/` (完**整**出**站**实**现**)
- `dist/extensions/minimax/` (M2.7 / T2A v2 接**入**)

### A.4 xiaozhi 协**议** 源**码** (借**鉴**)

- `/root/xiaozhi-esp32-server/main/xiaozhi-server/core/connection.py` (连**接**主**循**环**)
- `/root/xiaozhi-esp32-server/main/xiaozhi-server/core/websocket_server.py` (WS 服**务**)
- `/root/xiaozhi-esp32-server/main/xiaozhi-server/core/handle/textHandler/*.py` (7 个**消**息**类**型**)
- `/root/xiaozhi-esp32-server/main/xiaozhi-server/core/handle/helloHandle.py` (Hello 消**息**入**门**)

### A.5 我**们**现**有** V2 资**产** (v0.2.13)

- `bridge/src/xiaozhi_bridge/server.py` (664 行**)
- `bridge/src/xiaozhi_bridge/{asr,tts,llm,mcp,pipeline,audio,handle}/` (18 个**模**块**)
- `bridge/tests/` (154 个**测**试**)
- `bridge/docs/` (9 份**文**档**)
- `bridge/pyproject.toml`
- `bridge/Dockerfile.bridge`
- `docker-compose.yml`
- `data/bridge.db` (5.4 MB)
