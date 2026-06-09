/**
 * Channel plugin object (assembled).
 *
 * This file exports the actual `ChannelPlugin<XiaozhiAccount>` instance.
 * openclaw loads it lazily via `defineBundledChannelEntry`'s
 * `plugin.specifier + exportName` mechanism.
 */

import { createXiaozhiChannelPlugin } from "./channel.js";
import { setOpenClawAgentToolsProvider } from "./mcp/inbound.js";
import { createListDevicesTool, createEsp32DeviceToolRouter } from "./mcp/tools.js";

// v0.3.7 (M4 fix): install a *provider* for the openclaw agent tool
// list, not a static snapshot. The provider is invoked on every
// esp32 tools/list / tools/call request, so the tool list stays
// live as devices connect/disconnect.
//
// C 方案: 透传 ChannelAgentTool[] (跟 mcp/tools.ts 里的
// createListDevicesTool / createEsp32DeviceToolRouter 返回 shape 一致).
// 1:1 拷贝整个工具对象, 不再 wrap 成自定义 OpenClawAgentTool 类型.
//
// 注: createEsp32DeviceToolRouter 是 ChannelAgentToolFactory, 签名
// `(params: { cfg?: OpenClawConfig }) => ChannelAgentTool[]`,
// channel.ts 里传的是函数引用 `agentTools: [..., createEsp32DeviceToolRouter]`,
// openclaw 自己在 tool discovery 阶段才调它. 但 setOpenClawAgentToolsProvider
// 这里需要 provider 返回当前 tool 列表给 esp32 端 tools/list / tools/call,
// 所以我们要主动调它, 传空 cfg. 这是 1:1 跟 channel.ts 的 openclaw-side
// 调用并存的, 2 个 caller 互不影响 (channel.ts 给 openclaw, 我们给 esp32).
setOpenClawAgentToolsProvider(() => {
  const listTool = createListDevicesTool();
  const deviceTools = createEsp32DeviceToolRouter({ cfg: undefined });
  return [listTool, ...deviceTools];
});

export const xiaozhiPlugin = createXiaozhiChannelPlugin();
