# V3 SDK Research: openclaw xiaozhi Plugin (M3.1 阶段产出)

> **Status**: Research complete (1.5 个月实战经验 + 官方 SDK 调研)
> **Author**: Jarvis (OpenClaw runtime)
> **Date**: 2026-06-06 (周六凌晨)
> **Purpose**: 把"我们 1.5 个月摸出来的 xiaozhi 协议经验"和"openclaw SDK 接口"对齐成 1:1 映射表
> **Audience**: M3.2 写 plugin 的我 (下次跑这个研究时)

---

## 0. TL;DR (Allen 30 秒阅读版)

**我们 1.5 个月摸了 4 类资产, plugin 必须 1:1 复用:**

| 资产 | 文件 | 复用方式 | 关键点 |
|---|---|---|---|
| **xiaozhi 消息协议** (Hello/Listen/Abort/MCP) | `bridge/src/xiaozhi_bridge/protocol/messages.py` | 转译成 openclaw `MsgContext` | 4 消息类型 + 6 服务端消息 |
| **Opus 编解码** (16kHz/24kHz) | `bridge/src/xiaozhi_bridge/protocol/audio.py` | 调 `opuslib` | 60ms 帧 / decoder stateful per session |
| **VAD 唤醒缓冲** (2s grace) | `bridge/src/xiaozhi_bridge/audio/handler.py` | 调 `silero-vad` | wake word 尾部 2s 不判 voice |
| **反向 MCP 翻译** (bridge→esp32) | `bridge/src/xiaozhi_bridge/mcp/{client,manager,handlers}.py` | 转译成 openclaw `agentTools` | JSON-RPC 2.0 / per-session future |
| **WS handshake + auth** | `server.py _handle_connection` | 转译成 `startAccount` | device_id / Authorization / per-device token |
| **记忆 (per-device 隔离)** | `llm/openclaw.py user` 字段 | 转译成 `MsgContext.user = xiaozhi-${deviceId}` | V2 #37 撞过写死 user 的 bug |

**openclaw SDK 调研: ChannelPlugin 17 字段 + 4 个核心 adapter 接**口**已摸清。**

**下一**步** M3.1d: 在 `/root/openclaw-xiaozhi-plugin/` 创**建**仓**库** + 写**骨**架**。**

---

## 1. 我们 1.5 个月摸出来的 xiaozhi 协议经验 (最值钱)

### 1.1 xiaozhi WS 协议消息全**表**

来源: `bridge/src/xiaozhi_bridge/protocol/messages.py` + `bridge/docs/protocol.md`

#### C2S (Client → Server, esp32 → bridge)

| 消息 | type | 字段 | 含义 | 我们的处理 |
|---|---|---|---|---|
| **HelloMessage** | `"hello"` | `version`, `features.mcp`, `audio_params.{format,sample_rate,channels,frame_duration}` | 初始握手 (1 次) | `_handle_connection` 接收, 验**证**鉴**权**, 创建 session, 回 ServerHello |
| **ListenMessage** | `"listen"` | `state ∈ {start, stop, detect}`, `mode ∈ {auto, manual, realtime}`, `text` (仅 detect) | 录音状态变化 | start → VAD + Opus 缓冲; stop → ASR; detect → LLM with text |
| **AbortMessage** | `"abort"` | `reason` (e.g. "wake_word_detected") | 中断当前 TTS | 调 `session.cancelTurn`, openclaw abort |
| **MCPMessage** | `"mcp"` | `payload: dict` (JSON-RPC 2.0) | MCP 调用或响应 | 派发到 `mcp/handlers` (反向 MCP) |

#### S2C (Server → Client, bridge → esp32)

| 消息 | type | 字段 | 含义 | 我们的发送 |
|---|---|---|---|---|
| **ServerHello** | `"hello"` | `session_id`, `audio_params` | 握手响应 | 接收 C2S Hello 后立刻回 |
| **STTMessage** | `"stt"` | `text` | ASR 结果 (V2 #10 之前发送, V2 #10 后保留) | ASR 完成后 |
| **LLMMessage** | `"llm"` | `emotion`, `text` (emoji) | LLM 表情/动作提示 | LLM 流式响应时同步发送 |
| **TTSMessage** | `"tts"` | `state ∈ {start, sentence_start, stop}`, `text` (仅 sentence_start) | TTS 状态机 | TTS 开始/每句/结束 |
| **SystemMessage** | `"system"` | `command` (e.g. "reboot") | 系统指令 (OTA 后) | OTA 完成后 |
| **MCPMessage** | `"mcp"` | `payload: dict` (JSON-RPC 2.0) | 反向 MCP 调用 | 调 esp32 工具 (set_volume, ...) |

#### 二进制帧

- **Opus 帧** (16 kHz mono, 60 ms 帧) = esp32 → bridge 的 PCM
- **Opus 帧** (24 kHz mono, 60 ms 帧) = bridge → esp32 的 TTS
- **Opus 编**解**码** stateful** —— **每 session 1 个** decoder / encoder**（**复**用**）**

### 1.2 消息状态机 (听**起**来**复**杂** + 听**起**来**简**单**)

#### 听**起**来**复**杂**的** xiaozhi 听**起**来**状**态**机**:

```
[IDLE]
   ↓ (wake word OR 按钮)
[LISTENING] ←─── start ───┐
   ↓ (VAD voice_stop)      │ (binary Opus frames flowing)
[THINKING]                │
   ↓ (ASR done)           │ (wake grace 2s 期间 VAD 失效)
[LISTENING] ←─ stop ──────┘
   ↓ (LLM streaming)
[SPEAKING]
   ↓ (TTS done)
[IDLE]
```

**关**键** 4 点**（**V2 #8.3 摸**出**的**）**：
1. **VAD** 不**是** esp32 完**全**托**管**的** —— **server 端**也**要**跑** Silero VAD 兜**底**（**esp32 AFE VAD mode 0 在**实**际**环**境**不**触**发** voice_stop**）**
2. **wake grace** 2s —— 唤**醒**词**尾**部**音**频**容**易**误**触**发** VAD, **设** 2s grace
3. **Opus decoder** stateful —— 每** session 1 个** decoder (不**能**反复**创**建**)
4. **VAD reset** per session —— 避**免**上**一**轮**对**话**的** state 影**响**下**一**轮**

#### 听**起**来**简**单**的** openclaw 翻**译**:

```
esp32 Hello  ──> openclaw session created (key=session-${id})
esp32 Listen(start) + binary Opus  ──> openclaw tools.media.audio (ASR auto)
                    ↓
                ASR text  ──> openclaw agent-loop (LLM + tools)
                    ↓
                LLM stream  ──> openclaw outbound.sendTtsAudio
                    ↓
esp32 TTS sentence_start + Opus frames
esp32 Listen(stop)  ──> openclaw complete turn
```

### 1.3 1.5 个月撞过的 4 类坑 (必**记**录**到** plugin)

| 坑 | 详细 | 触**发**场**景** | plugin 必**做** |
|---|---|---|---|
| **Opus 帧** int16 vs float32** | `opuslib.Decoder.decode(opus_frame, frame_size)` 接 int16 | sensor 帧解析错误 | 使用 opuslib 默**认** int16 |
| **鉴**权** 3 API 形**状**差**异** | websockets < 14/14-15/16+ 拿 `request_headers` / `handshake.headers` / `request.headers` 不**一**样** | V2 #4 升**级** websockets 16+ 时**无**声**掉** device_id | 抽**取** `_get_header` 纯**函**数**，3 个** if-elif 兜**底** |
| **MCP JSON-RPC id 类**型** | esp32 发** id 是** string** "1"，**但** 整**数** 1 也**合**法** | 派**发**时**类**型**错**误** | 用 `int(payload["id"])` 强**制** + try/except |
| **session 关闭 vs future 未**完**成** | esp32 断**开** 时**还**有** mcp future 在**等** | "Task was destroyed but it is pending" 警**告** | session 关闭时**遍**历** `pending_mcp_calls`, set_exception |
| **V2 #8 激活**字**段** "00:00:00"** | OTA 返**回**的** `activation.code` 是** string** "00:00:00", 不**是** None | 死**循**环** `Activating... N/10` | 不**返** activation** 字**段** (M2 #8.1 fix) |
| **边**缘** TTS 不**做** 64kHz** | edge-tts 输**出** mp3 24kHz, esp32 要** 16kHz/24kHz | ffmpeg 转**码**错**误** | 显**式** `-ar 24000` 转**码** |

### 1.4 1.5 个月摸出来的反向 MCP 模式 (V2 #7 + V2 #11a)

**MCP JSON-RPC 2.0 over xiaozhi WS, 2 种 case:**

#### Case 1: Request (esp32 → bridge)

```json
{
  "type": "mcp",
  "session_id": "xiaozhi-abc123",
  "payload": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {"name": "set_volume", "arguments": {"volume": 50}}
  }
}
```

**bridge 处理** (`mcpMessageHandler.py`):
1. `payload["id"]` + `"method" in payload` → 这是 request
2. 派**发**到 `MCPServer.handle(payload)` (我**们**的** MCP server, 模**拟** "esp32 tool" 的**应**用**层)
3. 返**回** JSON-RPC response

**plugin 翻**译**: 把** esp32 上**报**的**工**具**列**表** (`tools/list`) 注**册**为** openclaw `agentTools`** —— **openclaw 的** LLM 可**以**直**接**调**用** esp32 工**具**。

#### Case 2: Response (esp32 → bridge, 应**答** bridge 的**调**用**)

```json
{
  "type": "mcp",
  "session_id": "xiaozhi-abc123",
  "payload": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {"volume": 50}
  }
}
```

**bridge 处理**:
1. `payload["id"]` + `"method" not in payload` → 这是 response
2. 从 `session.pending_mcp_calls` pop 出 future
3. `future.set_result(payload["result"])` 解**锁** 调**用**方

**plugin 翻**译**: plugin **调** openclaw `agentTools.execute()`, 返**回**给** LLM, LLM 拿**到**结**果**继**续**生**成**。

### 1.5 1.5 个月摸出来的记忆问题 (V2 #37)

**症状**: 我**们**的** `user: "xiaozhi-bridge"` 写**死** → 多**设**备**记**忆**混**乱**

**修法** (M3.6 必**做**):
```typescript
// 修前 (V0.2.13)
const msgContext = { user: "xiaozhi-bridge", body: text };

// 修后 (M3.6)
const msgContext = { 
  user: `xiaozhi-${deviceId}`,  // 按设备隔离
  body: text 
};
```

**已**验**证**: openclaw live test 同** user 记**住**、**不**同** user 隔**离**。

---

## 2. openclaw SDK 调研成果 (M3.1b 阶段产出)

### 2.1 ChannelPlugin 17 字段 (SDK 主**类**型**)

来源: `dist/plugin-sdk/types.public-CsG15_M2.d.ts:9-46`

```typescript
type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  // ---- 标识 (3) ----
  id: ChannelId;                                        // "xiaozhi"
  meta: ChannelMeta;                                    // { label: "Xiaozhi Device", icon: "..." }
  capabilities: ChannelCapabilities;                    // { text, voice, audio, mcp, ... }
  
  // ---- 配**置** (5) ----
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  setupWizard?: ChannelPluginSetupWizard;
  
  // ---- 配**置**响**应** (10) ----
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;     // ★ 我**们**的** startAccount 在**这**里**
  auth?: ChannelAuthAdapter;
  approvalCapability?: ChannelApprovalCapability;
  elevated?: ChannelElevatedAdapter;
  
  // ---- 生**命**周**期** (12) ----
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  allowlist?: ChannelAllowlistAdapter;
  doctor?: ChannelDoctorAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  streaming?: ChannelStreamingAdapter;                  // ★ 流**式**配**置**
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelMessagingAdapter;                  // ★ 入**站**派**发**到** agent
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];  // ★ esp32 工**具**注**册**
};
```

**我**们**必**做**的** 8 个**核**心**字**段**:
1. `id` = `"xiaozhi"`
2. `meta` = `{ label: "Xiaozhi Device", icon: "🎙️" }`
3. `capabilities` = `{ text, voice, audio, mcp, thread }`
4. `config` + `configSchema` = 配**置** wssUrl, port, tls
5. `gateway` = `startAccount` 启**动** wss:// 服**务** (esp32 → openclaw)
6. `messaging` = 入**站** esp32 消**息** → `MsgContext` (派**发**到** agent-loop)
7. `outbound` = openclaw → esp32 (tts 音**频** + mcp 调**用**)
8. `agentTools` = esp32 上**报**的**工**具** (V3.7 M3.7)

### 2.2 ChannelGatewayAdapter (startAccount 启**动**服**务**)

来源: `dist/plugin-sdk/types.adapters-5-zlux7w.d.ts`

```typescript
type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => string[];
  loginWithQrStart?: (params: { ... }) => Promise<...>;
  loginWithQrWait?: (params: { ... }) => Promise<...>;
  logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
};

type ChannelGatewayContext<ResolvedAccount> = {
  cfg: OpenClawConfig;
  account: ResolvedAccount;        // 我**们**的** XiaozhiAccount
  channelRuntime?: any;            // 派**发**入**站**消**息**到** agent-loop
  abortSignal: AbortSignal;        // 关**闭**时**触**发**
  log: PluginLogger;
  // ...
};
```

**SMS plugin 范**例** (startAccount)** (`dist/extensions/sms/channel-plugin-api.js`):
```javascript
async function startSmsGatewayAccount(params) {
  if (!params.account.enabled) {
    params.log?.info?.(`SMS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectSmsStartupWarnings(params.account);
  // ... 警**告**处**理**
  const unregister = registerSmsWebhookRoute(params);
  params.log?.info?.(`Registered SMS webhook route ${params.account.webhookPath}`);
  return waitUntilAbort(params.abortSignal, unregister);
}
```

**我**们**的**实**现** (伪代**码**, M3.2 写**):
```typescript
async function startXiaozhiGatewayAccount(ctx) {
  // 1. 启**动** wss://0.0.0.0:18789/xiaozhi/v1/
  const server = await startWssServer({
    cfg: ctx.cfg,
    account: ctx.account,
    abortSignal: ctx.abortSignal,
    log: ctx.log,
  });
  
  // 2. 处**理**每**个** esp32 连**接**
  server.on('connection', (ws, req) => {
    handleEsp32Connection(ctx, ws, req);
  });
  
  // 3. 等**到**关**闭**
  return waitUntilAbort(ctx.abortSignal, () => server.close());
}

function handleEsp32Connection(ctx, ws, req) {
  // 1. 握**手** (HelloMessage + auth)
  // 2. 注册 session (key = `xiaozhi-${deviceId}`)
  // 3. 派**发**入**站**消**息**到** ctx.channelRuntime.dispatch(msgContext)
  // 4. 出**站**消**息** 走** ctx.channelRuntime.subscribeOutbound(...)
}
```

### 2.3 ChannelMessagingAdapter (入**站**派**发**)

```typescript
type ChannelMessagingAdapter = {
  targetPrefixes?: readonly string[];                  // ["xiaozhi:esp32-58e6c56b9b54"]
  normalizeTarget?: (raw: string) => string | undefined;
  defaultMarkdownTableMode?: MarkdownTableMode;
  normalizeExplicitSessionKey?: (params: { sessionKey: string; ctx: MsgContext }) => string | undefined;
  deriveLegacySessionChatType?: (sessionKey: string) => "direct" | "group" | "channel" | undefined;
  // ... 14 个**方**法**
};
```

**我**们**的**实**现** (伪代**码**):
```typescript
messaging: {
  targetPrefixes: ["xiaozhi:"] as const,
  normalizeTarget: (raw) => {
    // "xiaozhi:esp32-58e6c56b9b54" -> "esp32-58e6c56b9b54"
    if (raw.startsWith("xiaozhi:")) return raw.slice(8);
    return undefined;
  },
  deriveLegacySessionChatType: (sessionKey) => "direct",
}
```

### 2.4 ChannelOutboundAdapter (出**站**返**回** esp32)

来源: `dist/plugin-sdk/outbound.types-CLmrfAQv.d.ts`

```typescript
type ChannelOutboundAdapter = {
  sendText?: (params: { ... }) => Promise<OutboundDeliveryResult>;
  sendMedia?: (params: { ... }) => Promise<OutboundDeliveryResult>;
  sendTtsAudio?: (params: { 
    audio: Buffer;        // ★ 24kHz Opus / mp3
    text: string;
    cfg: OpenClawConfig;
    accountId?: string;
    // ...
  }) => Promise<OutboundDeliveryResult>;
};
```

**OutboundDeliveryResult**:
```typescript
type OutboundDeliveryResult = {
  channel: Exclude<ChannelId, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  receipt?: MessageReceipt;
  meta?: Record<string, unknown>;
};
```

**我**们**的**实**现** (伪代**码**):
```typescript
outbound: {
  sendTtsAudio: async ({ audio, text, accountId, log }) => {
    const session = sessions.get(accountId);
    if (!session) throw new Error(`No session for ${accountId}`);
    
    // 1. 翻**译**为** xiaozhi TTS 消**息** (sentence_start + audio 帧 + stop)
    // 2. await ws.send(serializeTtsMessage({ state: "start" }));
    // 3. await ws.send(serializeTtsMessage({ state: "sentence_start", text }));
    // 4. await ws.send(audio);  // Opus 帧**
    // 5. await ws.send(serializeTtsMessage({ state: "stop" }));
    
    return { channel: "xiaozhi", messageId: ulid(), chatId: session.sessionId };
  }
}
```

### 2.5 ChannelStreamingAdapter (流**式**音**频**)

```typescript
type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: { minChars: number; idleMs: number };
};
```

**我**们**的**实**现**:
```typescript
streaming: {
  blockStreamingCoalesceDefaults: { minChars: 50, idleMs: 200 }
}
```

### 2.6 ChannelAgentToolFactory (esp32 工**具**注**册**)

**agentTools 是 M3.7 (反**向** MCP) 的**入**口**。**我**们**在** M3.2 骨**架**先**放** 1 个** list_devices 工**具**做**范**例**。**

```typescript
agentTools: [
  {
    name: "xiaozhi_list_devices",
    description: "List all connected ESP32 xiaozhi devices",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      return JSON.stringify(Array.from(devices.values()).map(d => ({
        deviceId: d.deviceId,
        sessionId: d.sessionId,
        connectedAt: d.connectedAt,
      })));
    },
  }
]
```

### 2.7 ChannelCapabilities (能**力**清**单**)

**我**们**的**实**现**:
```typescript
capabilities: {
  text: true,        // 支**持**文**本**对**话** (LLM 返**回**文**本**)
  voice: true,       // 支**持**语**音**对**话** (TTS)
  audio: true,       // 支**持**音**频**输**入** (ASR)
  mcp: true,         // 支**持** MCP 协**议** (V3.7)
  thread: false,     // 不**支**持**线**程**
  reactions: false,  // 不**支**持** emoji
  edits: false,      // 不**支**持**编**辑**消**息**
  // ...
}
```

---

## 3. xiaozhi ↔ openclaw 1:1 翻**译**表** (M3.2 实**现**指**南**)

### 3.1 入**站** (esp32 → openclaw)

| xiaozhi 消**息** | 我**们**现**在**做**什**么** | plugin 怎**么**翻**译** | openclaw 入**口** |
|---|---|---|---|
| **Hello** (audio_params + features.mcp) | 解**析** + 创**建** session + 鉴**权** | 创**建** `MsgContext` (空 body), 调** `channelRuntime.dispatch(ctx)` | `MsgContext.body = ""`, `from = deviceId`, `sessionKey = xiaozhi-${deviceId}` |
| **Listen start** + 二**进**制** Opus 帧** | 1. 解**码** Opus → PCM; 2. VAD 判**断**; 3. 缓**冲** | 创**建** audio chunk: `MsgContext.media = [{ mime: "audio/opus", data: opusFrame, sampleRate: 16000, channels: 1 }]` 派**发**到** `channelRuntime.dispatch(ctx)` | openclaw auto-detect ASR (SenseAudio 周**一**或 sherpa-onnx 过**渡**) |
| **Listen stop** | 触**发** `_process_turn` (ASR + LLM + TTS) | 调**用** `channelRuntime.endTurn(ctx)` | openclaw 完**成**本**轮**, 出**站** TTS 音**频** |
| **Listen detect** + text | 直**接**调** LLM** (不**走** ASR) | 创**建** `MsgContext.body = msg.text`, 派**发** | openclaw 直**接**进**入** LLM |
| **Abort** | 调** `session.cancelTurn()` | 调**用** `channelRuntime.cancelTurn(ctx, { reason })` | openclaw abort 当**前** TTS/LLM |
| **MCP** (JSON-RPC 2.0) | 派**发**到** MCPServer / pending_mcp_calls | 调**用**对**应**的** `agentTools` (M3.7) | openclaw 工**具**调**用** |
| **Ping** (keepalive) | 转**发** | 直**接** ws.send 响**应** (不**走** openclaw) | - |

### 3.2 出**站** (openclaw → esp32)

| openclaw 出**站** | 我**们**现**在**发**什**么** | plugin 怎**么**翻**译** | xiaozhi 出**口** |
|---|---|---|---|
| **outbound.sendText** | 直**接**发**送** `text` 消**息** | 翻**译**为** xiaozii `STTMessage` (`type: "stt"`, `text`) | esp32 收**到** STT |
| **outbound.sendTtsAudio** | 发**送** TTSMessage + Opus 帧 | 翻**译**为** xiaozhi 状态**机**: `tts.start` → `tts.sentence_start` + text → Opus 帧** → `tts.stop` | esp32 播**放** TTS |
| **outbound.sendMedia** | 暂**不**用** | 翻**译**为** `LLMMessage` (`type: "llm"`, `emotion`, `text`) + `SystemMessage` | esp32 表**情**/动**画** |
| **MCP 调**用** (M3.7)** | 调**用** esp32 工具 (set_volume) | 翻**译**为** xiaozhi `MCPMessage` (`type: "mcp"`, `payload: {jsonrpc, id, method, params}`) | esp32 收**到** MCP, 执**行**工**具** |
| **SystemMessage** | 重**启** / OTA | 翻**译**为** xiaozhi `SystemMessage` (`type: "system"`, `command`) | esp32 执**行**系**统**指**令** |

### 3.3 反**向** MCP 翻**译** (M3.7 重**点**)

| 工**具**调**用**方**向** | xiaozhi 消**息** | openclaw 翻**译** | 实**现**位**置** |
|---|---|---|---|
| **esp32 → bridge → LLM** (esp32 有**工**具**, LLM 调**用**) | `MCPMessage{ payload: { jsonrpc, id, method: "tools/call", params: { name, arguments }}}` | 1. `agentTools` 派**发**到**对**应**的** esp32 会**话**; 2. await `future`; 3. 返**回** JSON-RPC response | `src/mcp/inbound.ts` |
| **bridge → esp32** (LLM 调**用** esp32 工**具**) | `MCPMessage{ payload: { jsonrpc, id, method: "tools/call", params: { name, arguments }}}` (server→client) | 1. `agentTools.execute()` 创**建** `future`; 2. 发**送** xiaozhi MCP 消**息**; 3. 等** esp32 响**应** (`session.pending_mcp_calls`); 4. `future.set_result(result)` | `src/mcp/outbound.ts` |

---

## 4. plugin 仓**库**创**建**清**单** (M3.1d)

### 4.1 目**录**结**构**

```
/root/openclaw-xiaozhi-plugin/
├── package.json                          # npm 配**置**
├── tsconfig.json                         # TypeScript 配**置**
├── vitest.config.ts                      # vitest 配**置**
├── manifest.json                         # plugin 元**数**据**
├── README.md                             # 使用**说**明**
├── LICENSE                               # 开**源**协**议**
├── .gitignore
├── src/
│   ├── index.ts                          # 出**口** (createXiaozhiChannelPlugin)
│   ├── channel.ts                        # 主 ChannelPlugin 装**配** (17 字**段**)
│   ├── config.ts                         # ChannelConfigAdapter + XiaozhiAccount
│   ├── gateway.ts                        # ChannelGatewayAdapter (startAccount)
│   ├── inbound.ts                        # esp32 WS 服**务** + 派**发**到** openclaw
│   ├── outbound.ts                       # openclaw → esp32 (TTS, MCP, text)
│   ├── protocol.ts                       # xiaozhi 消**息** schema + 解**析**
│   ├── audio.ts                          # Opus ↔ PCM 互**转** (A3 过**渡**用**)
│   ├── session.ts                        # device_id → session_key 映**射**
│   ├── tools.ts                          # 1 个**范**例** agent tool
│   ├── mcp/
│   │   ├── inbound.ts                    # esp32 MCP → openclaw agent tool
│   │   └── outbound.ts                   # openclaw agent tool → esp32 MCP
│   └── tests/
│       ├── test-protocol.ts              # xiaozhi 消**息**解**析** 25 个**测**试**
│       ├── test-inbound.ts               # 派**发**到** agent 15 个**测**试**
│       ├── test-outbound.ts              # 出**站** TTS/MCP 15 个**测**试**
│       ├── test-session.ts               # device_id 隔**离** 10 个**测**试**
│       ├── test-mcp.ts                   # 反**向** MCP 10 个**测**试**
│       └── test-config.ts                # 配**置**解**析** 10 个**测**试**
├── docs/
│   ├── plan-v3-xiaozhi-plugin.md         # 复**制**自** xiaozhi-bridge
│   ├── sdk-research-v3.md                # 本**文**档**
│   ├── message-protocol.md               # xiaozhi 消**息** schema 详**细**说**明**
│   └── testing.md                        # 测**试**手**册**
└── scripts/
    └── install.sh                        # `openclaw plugin install .` 后**处**理
```

### 4.2 package.json 关**键**配**置**

```json
{
  "name": "openclaw-xiaozhi-plugin",
  "version": "0.3.0",
  "description": "Xiaozhi ESP32 device as a native openclaw channel",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "openclaw": "2026.6.1",
    "ws": "^8.18.0",
    "opuslib": "^3.0.1",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/ws": "^8.5.10"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 4.3 manifest.json (plugin 元**数**据**)

```json
{
  "id": "xiaozhi",
  "name": "Xiaozhi Device Channel",
  "version": "0.3.0",
  "description": "ESP32 xiaozhi protocol as a native openclaw channel",
  "openclaw": {
    "minVersion": "2026.6.0"
  },
  "main": "dist/index.js"
}
```

### 4.4 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

---

## 5. M3.1 阶**段**任**务**清**单** (本**阶**段**已**完**成**)

- [x] **M3.1a**: 梳**理** "**我**们**已**经**知**道**什**么**"** (本**文**档** §1)
- [x] **M3.1b**: SDK 调**研** (本**文**档** §2)
- [x] **M3.1c**: 产**出** sdk-research-v3.md (本**文**档**)
- [ ] **M3.1d**: 创**建** `openclaw-xiaozhi-plugin/` 仓**库** (§4)

---

## 6. M3.2 阶**段**实**施**指**南** (下**一**步**)

按**本**文**档** §3 翻**译**表** + §4 仓**库**结**构**，**顺**序**实**现**：

1. **`src/protocol.ts`** —— xiaozhi 消**息** schema + parse_client_message/serialize_server_message
   - **直**接** 1:1 复**制** `bridge/src/xiaozhi_bridge/protocol/messages.py` 翻**译**为** TypeScript
   - **先**写**测**试** (TDD)
2. **`src/audio.ts`** —— Opus 编**解**码** (`OpusCodec` 类** 1:1 翻**译**)
   - **用** `opuslib` 替**代** Python 的** `opuslib`
3. **`src/session.ts`** —— `SessionContext` 类** (device_id, session_id, state, ...)
4. **`src/config.ts`** —— `XiaozhiAccount` 配**置** (host, port, path, tls, auth_tokens)
5. **`src/gateway.ts`** —— `startXiaozhiGatewayAccount` (wss 服**务** + 鉴**权** + session 创**建**)
6. **`src/inbound.ts`** —— esp32 消**息**派**发** (Hello/Listen/Abort/MCP → openclaw MsgContext)
7. **`src/outbound.ts`** —— openclaw 出**站** → esp32 (TTS 状**态**机** + text + MCP)
8. **`src/mcp/{inbound,outbound}.ts`** —— 反**向** MCP (M3.7 必**做**)
9. **`src/tools.ts`** —— 1 个**范**例** agent tool (`xiaozhi_list_devices`)
10. **`src/channel.ts`** —— `createXiaozhiChannelPlugin()` 装**配** 17 字**段**
11. **`src/index.ts`** —— 出**口**

**预**估**: ~500-700 行** TypeScript**, 85 个** vitest 用**例**。**M3.2 完**成**后**进** M3.3 本**地**端**到**端**联**调**。**

---

## 7. 答**案**记**录** (Allen 拍**板**)

| # | 问**题** | 答**案** | 拍**板**日**期** |
|---|---|---|---|
| Q1 | plugin 装**在**哪**？** | 全**局** (装**在** `~/.openclaw/plugins/`) | 2026-06-05 |
| Q2 | TTS 用**哪**个**？** | MiniMax T2A v2 (speech-2.8-hd) | 2026-06-05 |
| Q3 | ASR 用**哪**个**？** | A1 SenseAudio (周**一**拿** key) + A3 sherpa-onnx 过**渡** | 2026-06-05 |
| Q4 | 是**否**保**留** xiaozhi-bridge 仓**库**？** | 保**留** (打 legacy tag) | 2026-06-05 |
| Q5 | M3.6+ 做**什**么**？** | M3.6 记**忆** (按**设**备**分** user) + M3.7 反**向** MCP 透**传** | 2026-06-05 |
| Q6 | 1.5 个**月**摸**出**的**经**验**怎**么**进** plugin**？** | 100% 1:1 翻**译** (本**文**档** §3) | 2026-06-06 |

---

## 8. 附**录** A: 我**们**摸**出**的**全**部**关**键**文**件**清**单**

### A.1 xiaozhi-bridge 仓**库** (v0.2.13, 6600 行**)

| 文**件** | 行**数** | 内**容** | plugin 怎**么**用** |
|---|---|---|---|
| `bridge/src/xiaozhi_bridge/server.py` | 664 | WS 服**务**主**循**环** + 握**手** + 鉴**权** | `gateway.ts` + `inbound.ts` |
| `bridge/src/xiaozhi_bridge/protocol/messages.py` | 200 | xiaozhi 消**息** schema (Hello/Listen/Abort/MCP/Server/...) | `protocol.ts` 1:1 翻**译** |
| `bridge/src/xiaozhi_bridge/protocol/audio.py` | 100 | Opus 编**解**码** (16kHz/24kHz) | `audio.ts` 1:1 翻**译** |
| `bridge/src/xiaozhi_bridge/protocol/states.py` | 50 | SessionState 枚**举** (IDLE/LISTENING/THINKING/SPEAKING) | `protocol.ts` 1:1 翻**译** |
| `bridge/src/xiaozhi_bridge/handle/textHandler/listenMessageHandler.py` | 68 | Listen 状**态**机** (start/stop/detect) | `inbound.ts` 翻**译**到** MsgContext |
| `bridge/src/xiaozhi_bridge/handle/textHandler/mcpMessageHandler.py` | 53 | MCP JSON-RPC 派**发** | `mcp/inbound.ts` 1:1 翻**译** |
| `bridge/src/xiaozhi_bridge/audio/handler.py` | 129 | Opus + VAD + wake-grace | `inbound.ts` + `audio.ts` |
| `bridge/src/xiaozhi_bridge/vad/silero.py` | ? | Silero VAD (本**地** ONNX) | 周**一**后**退**役** (切 SenseAudio) |
| `bridge/src/xiaozhi_bridge/llm/openclaw.py` | 295 | openclaw LLM 客**户**端** (chat completions) | **不**再**需**要** (openclaw 内**部**完**成**) |
| `bridge/src/xiaozhi_bridge/mcp/handlers.py` | 257 | 反**向** MCP 翻**译** | `mcp/{inbound,outbound}.ts` 1:1 翻**译** |
| `bridge/src/xiaozhi_bridge/mcp/client.py` | 179 | MCPClient (per-session + asyncio.Lock) | `session.ts` |
| `bridge/src/xiaozhi_bridge/mcp/manager.py` | 287 | ToolManager + ToolType + ToolExecutor | `tools.ts` |
| `bridge/src/xiaozhi_bridge/config.py` | 243 | 配**置** (Server/OpenClaw/ASR/TTS/...) | `config.ts` 简**化** (只**要** wssUrl + tls) |
| `bridge/tests/` | 154 个** | pytest 测**试** | **废**, 改** vitest (85 个**) |

### A.2 openclaw 仓**库** (2026.6.1)

| 文**件** | 路径 | 用**途** |
|---|---|---|
| `ChannelPlugin` 主**类**型** | `dist/plugin-sdk/types.public-CsG15_M2.d.ts` | 17 字**段** 装**配** |
| `ChannelGatewayAdapter` | `dist/plugin-sdk/types.adapters-5-zlux7w.d.ts` | `startAccount` 启**动** wss 服**务** |
| `ChannelMessagingAdapter` | `dist/plugin-sdk/types.core-synVrH0Z.d.ts` | 入**站**派**发** |
| `ChannelOutboundAdapter` | `dist/plugin-sdk/outbound.types-CLmrfAQv.d.ts` | 出**站** sendTtsAudio |
| `ChannelStreamingAdapter` | `dist/plugin-sdk/types.core-synVrH0Z.d.ts` | 流**式**配**置** |
| SMS plugin 范**例** | `dist/extensions/sms/` | `startAccount` + `registerWebhookRoute` |
| Telegram plugin 范**例** | `dist/extensions/telegram/` | 完**整**的**出**站**实**现** |
| MiniMax provider 范**例** | `dist/extensions/minimax/` | T2A v2 + LLM + VLM |
| ASR SenseAudio 文**档** | `docs/providers/senseaudio.md` | A1 ASR 配**置** |
| TTS MiniMax 文**档** | `docs/providers/minimax.md` | B2 TTS 配**置** |
| SDK 开发指**南** | `docs/plugins/sdk-channel-plugins.md` | plugin 开**发**总**览** |
| 通**道**接**入**指**南** | `docs/install/development-channels.md` | channel 接**入**概**念** |

### A.3 xiaozhi-esp32-server 仓**库** (借**鉴**)

| 文**件** | 路径 | 用**途** |
|---|---|---|
| `core/connection.py` | `main/xiaozhi-server/core/connection.py` | ConnectionHandler 范**例** (我**们**的** server.py 仿**写**对**象**) |
| `core/handle/helloHandle.py` | `main/xiaozhi-server/core/handle/helloHandle.py` | Hello 消**息**入**门** (读**懂**之**后**才**写** plugin) |
| `core/handle/receiveAudioHandle.py` | `main/xiaozhi-server/core/handle/receiveAudioHandle.py` | 音**频**接**收** (Opus 帧**处**理**入**门**) |
| `core/handle/sendAudioHandle.py` | `main/xiaozhi-server/core/handle/sendAudioHandle.py` | TTS 音**频**发**送** (TTS 状**态**机**入**门**) |
| `core/textMessageHandlerRegistry.py` | `main/xiaozhi-server/core/textMessageHandlerRegistry.py` | 7 个**消**息**类**型**派**发**器** (我**们**的** registry 仿**写**对**象**) |

### A.4 参**考**文**档**

- `/root/projects/xiaozhi-bridge/docs/plan-v3-xiaozhi-plugin.md` (M3.0 总**体**规**划**)
- `/root/projects/xiaozhi-bridge/docs/protocol.md` (xiaozhi 协**议**详**细**说**明**)
- `/root/projects/xiaozhi-bridge/docs/architecture.md` (V0.2.13 架**构**)
- `/root/projects/xiaozhi-bridge/docs/changelog.md` (V0.1.0 → V0.2.13 历**史**)
