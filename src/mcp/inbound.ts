/**
 * MCP inbound — esp32 → openclaw tool router.
 *
 * esp32 reports a tool list via MCPMessage with method=tools/list.
 * We register each reported tool as a dynamic openclaw agent tool.
 *
 * M3.7: esp32 → LLM direction (LLM can call esp32 tools).
 *
 * @see docs/sdk-research-v3.md §3.3 (Case 1)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import type { XiaozhiContext } from "./types.js";

export async function handleMcpList(
  _ctx: XiaozhiContext,
  _tools: Array<{ name: string; description?: string; inputSchema: unknown }>,
): Promise<void> {
  // TODO(M3.7): implement
  //
  //   1. For each esp32-reported tool:
  //        ctx.agentTools.push(createEsp32ToolAdapter(ctx, tool))
  //   2. createEsp32ToolAdapter returns a ChannelAgentTool that:
  //        - on execute: sends MCPMessage{ tools/call } to esp32
  //        - awaits pendingMcpCalls.get(id)
  //        - returns result
}
