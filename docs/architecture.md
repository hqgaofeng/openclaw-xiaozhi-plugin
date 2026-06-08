# openclaw-xiaozhi-plugin Architecture (M3.5 v0.3.0)

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
