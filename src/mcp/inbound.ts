/**
 * MCP inbound — esp32 → openclaw tool router.
 *
 * Two responsibilities:
 *   A. Receive esp32 tools/list response (MCP JSON-RPC) → register each
 *      tool as an openclaw agent tool (createEsp32ToolAdapter).
 *   B. Receive esp32 tools/call response → resolve the matching
 *      pending call (delegated to outbound.resolveMcpResponse).
 *
 * Mirrors V2 #7 + V2 #11a bridge/src/xiaozhi_bridge/mcp/handlers.py:
 *   - register_device_tools()           → registerEsp32Tools()
 *   - _build_llm_tools_payload()        → toOpenAiFunctionShape loop
 *   - DeviceToolHandler.__call__()      → createEsp32ToolAdapter().execute
 *
 * @see docs/sdk-research-v3.md §3.3 (Case 1)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import type { WebSocket } from "ws";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-runtime";
import type { SessionContext } from "../session.js";
import {
  sendMcpCall,
  buildToolsListRequest,
  resolveMcpResponse,
} from "./outbound.js";
import {
  toOpenAiFunctionShape,
  type McpTool,
  type JsonRpcResponse,
  isJsonRpcResponse,
  isJsonRpcError,
} from "./protocol.js";

/** Adapter that wraps an esp32 tool as an openclaw agent tool. */
export function createEsp32ToolAdapter(
  ws: WebSocket,
  session: SessionContext,
  tool: McpTool,
): ChannelAgentTool {
  return {
    label: `esp32_${tool.name}`,
    name: `esp32_${tool.name}`,
    description: tool.description ?? `ESP32 device tool: ${tool.name}`,
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as unknown as ChannelAgentTool["parameters"],
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<{
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      >;
      details: unknown;
      isError?: boolean;
    }> => {
      void _toolCallId;
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const result = await sendMcpCall(ws, session, tool.name, args);
        // Normalize: esp32 returns { content: [...], isError?: bool }.
        // Audio content blocks are flattened to text (with base64 metadata)
        // because openclaw AgentToolResult doesn't support audio natively.
        if (
          result &&
          typeof result === "object" &&
          Array.isArray((result as { content?: unknown }).content)
        ) {
          const r = result as {
            content: Array<
              | { type: "text"; text: string }
              | { type: "image"; data: string; mimeType: string }
              | { type: "audio"; data: string; mimeType: string }
            >;
            isError?: boolean;
          };
          const flat = r.content.map((c) => {
            if (c.type === "audio") {
              return {
                type: "text" as const,
                text: `[audio ${c.mimeType} ${c.data.length} chars base64]`,
              };
            }
            return c;
          }) as Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          >;
          return { content: flat, details: r, isError: r.isError };
        }
        // Otherwise wrap as text.
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error calling esp32 tool '${tool.name}': ${(err as Error).message}`,
            },
          ],
          details: { error: (err as Error).message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Register a list of esp32-reported tools as openclaw agent tools.
 *
 * Mirrors V2 #7 register_device_tools. Returns the array of adapter
 * objects that the caller pushes into the openclaw agentTools list.
 */
export function registerEsp32Tools(
  ws: WebSocket,
  session: SessionContext,
  tools: McpTool[],
): ChannelAgentTool[] {
  return tools.map((tool) => createEsp32ToolAdapter(ws, session, tool));
}

/**
 * Convert esp32 tools to the OpenAI chat completions function-calling
 * payload. The LLM receives this so it knows what tools it can call.
 *
 * Mirrors V2 #7 _build_llm_tools_payload.
 */
export function buildLlmToolsPayload(tools: McpTool[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: McpTool["inputSchema"] };
}> {
  return tools.map(toOpenAiFunctionShape);
}

/**
 * Ask the esp32 device for its tool list. Call this once after
 * handshake. The response is handled by handleToolsListResponse().
 */
export function requestEsp32ToolsList(
  ws: WebSocket,
  session: SessionContext,
): void {
  ws.send(buildToolsListRequest(session.sessionId));
}

/**
 * Handle an MCP JSON-RPC response from esp32.
 *
 * Two cases:
 *   - method = "tools/list"  → return the tools array (caller registers)
 *   - method = "tools/call"  → resolve the pending call future
 *   - any error response     → reject the pending call
 *
 * Returns the tools array if this was a tools/list response,
 * or null if it was a tools/call response (or unrecognized).
 */
export function handleMcpResponse(
  session: SessionContext,
  response: JsonRpcResponse,
  /** If true, this is a tools/list response (we want to extract tools). */
  isToolsList: boolean,
): McpTool[] | null {
  if (!isJsonRpcResponse(response)) {
    return null;
  }

  if (isJsonRpcError(response)) {
    // Reject the pending call (if any).
    resolveMcpResponse(session, response.id, {
      error: response.error,
    });
    return null;
  }

  if (isToolsList) {
    // V2 #7: tools/list response is `{ tools: [...] }`.
    const result = response.result as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  // tools/call response — resolve the pending future with the result.
  resolveMcpResponse(session, response.id, { result: response.result });
  return null;
}
