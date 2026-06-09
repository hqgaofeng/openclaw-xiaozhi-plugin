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
  type JsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcError,
} from "./protocol.js";
import {
  serializeServerMessage,
  type ServerMessage,
} from "../protocol.js";

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

/**
 * v0.3.7 (M4 fix): reverse MCP channel — esp32 → openclaw tool router.
 *
 * When the esp32 device sends an MCP JSON-RPC 2.0 *request* (not a
 * response), it expects the openclaw side to dispatch the tool call
 * to a registered agent tool. This is symmetric to the existing
 * server→esp32 path in sendMcpCall().
 *
 * Two methods handled:
 *   - "tools/list"  → return list of available openclaw agent tools
 *                     formatted as MCP McpTool[]
 *   - "tools/call"  → look up the tool in the openclaw agent registry,
 *                     execute it, return the result (or error)
 *
 * Response format follows the same JSON-RPC 2.0 envelope the esp32
 * would normally see for its own outbound tools/call. The session_id
 * wrapper follows the xiaozhi protocol convention.
 *
 * C 方案: 直接用 openclaw `ChannelAgentTool` 类型 (跟 mcp/tools.ts 里
 * createListDevicesTool / createEsp32DeviceToolRouter 一致).
 * 真实签名 execute(toolCallId, params) → { content, details, isError? }.
 */

/**
 * Provider of the *current* openclaw agent tool list. Recomputed on
 * every call so newly-registered esp32 devices show up immediately.
 *
 * Default: a no-op empty list. The real provider is installed by
 * plugin-xiaozhi.ts at module-load time using setOpenClawAgentToolsProvider.
 */
let toolsProvider: () => ChannelAgentTool[] = () => [];

export function setOpenClawAgentToolsProvider(
  provider: () => ChannelAgentTool[],
): void {
  toolsProvider = provider;
}

/** Snapshot the current openclaw agent tool list (re-resolved each call). */
export function getOpenClawAgentTools(): ChannelAgentTool[] {
  return toolsProvider();
}

/** Send a JSON-RPC 2.0 success response to esp32. */
export function sendMcpResponse(
  ws: WebSocket,
  sessionId: string,
  id: number | string,
  result: unknown,
): void {
  const msg = {
    type: "mcp" as const,
    session_id: sessionId,
    payload: {
      jsonrpc: "2.0" as const,
      id,
      result,
    },
  };
  ws.send(serializeServerMessage(msg as unknown as ServerMessage));
}

/** Send a JSON-RPC 2.0 error response to esp32. */
export function sendMcpError(
  ws: WebSocket,
  sessionId: string,
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): void {
  const msg = {
    type: "mcp" as const,
    session_id: sessionId,
    payload: {
      jsonrpc: "2.0" as const,
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    },
  };
  ws.send(serializeServerMessage(msg as unknown as ServerMessage));
}

/**
 * Dispatch a JSON-RPC 2.0 request from esp32 to an openclaw agent tool.
 *
 * Tools are looked up by `params.name` in the registered openclaw
 * tool list. If not found, returns a JSON-RPC error with code
 * -32601 (Method not found).
 */
export async function handleEsp32McpRequest(
  ws: WebSocket,
  session: SessionContext,
  request: JsonRpcRequest,
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  },
): Promise<void> {
  const { id, method, params } = request;
  log.info(
    `xiaozhi: ${session.deviceId} mcp request: method=${method}, id=${id}`,
  );

  // Validate id (JSON-RPC requires id in request).
  if (id === undefined || id === null) {
    log.warn(`xiaozhi: ${session.deviceId} mcp request without id, dropping`);
    return;
  }

  if (method === "tools/list") {
    // v0.3.7: convert openclaw tool list to MCP McpTool shape.
    const tools = getOpenClawAgentTools();
    const mcpTools: McpTool[] = tools.map((t) => {
      // ChannelAgentTool 用 `parameters` 字段 (zod TSchema, 不是 {type:object})
      // MCP McpTool.inputSchema 要 { type: "object", properties?, required? }
      // ChannelAgentTool.parameters 在运行时就是 JSON Schema (zod 派生的)
      // 这里强制 cast unknown → McpTool["inputSchema"]
      const p = (t as unknown as { parameters?: unknown }).parameters;
      return {
        name: t.name,
        description: t.description,
        inputSchema: p as McpTool["inputSchema"] | undefined,
      };
    });
    sendMcpResponse(ws, session.sessionId, id, { tools: mcpTools });
    log.info(
      `xiaozhi: ${session.deviceId} tools/list served ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")}`,
    );
    return;
  }

  if (method === "tools/call") {
    // v0.3.7: dispatch to a registered openclaw agent tool.
    const callParams = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = callParams.name;
    if (typeof toolName !== "string" || toolName.length === 0) {
      sendMcpError(ws, session.sessionId, id, -32602, "params.name must be a non-empty string");
      return;
    }
    const args = callParams.arguments ?? {};
    const tool = getOpenClawAgentTools().find((t) => t.name === toolName);
    if (!tool) {
      sendMcpError(ws, session.sessionId, id, -32601, `tool '${toolName}' not found in openclaw registry`);
      log.warn(`xiaozhi: ${session.deviceId} requested unknown tool '${toolName}'`);
      return;
    }
    try {
      // ChannelAgentTool.execute signature: (toolCallId, params) → result
      const out = await tool.execute(`xiaozhi-mcp-${id}-${Date.now()}`, args);
      // OpenClaw AgentToolResult shape: { content, details, isError? }
      const content = Array.isArray((out as { content?: unknown }).content)
        ? (out as { content: unknown[] }).content
        : [{ type: "text" as const, text: JSON.stringify(out) }];
      const isError = (out as { isError?: boolean }).isError;
      sendMcpResponse(ws, session.sessionId, id, {
        content,
        ...(isError ? { isError } : {}),
      });
      log.info(
        `xiaozhi: ${session.deviceId} tool '${toolName}' executed, ` +
        `${content.length} content blocks, isError=${isError ?? false}`,
      );
    } catch (err) {
      const e = err as Error;
      sendMcpError(ws, session.sessionId, id, -32603, `tool execution failed: ${e.message}`);
      log.error(`xiaozhi: ${session.deviceId} tool '${toolName}' threw:`, e.message);
    }
    return;
  }

  // Unknown method — JSON-RPC standard error -32601.
  sendMcpError(ws, session.sessionId, id, -32601, `method '${method}' not supported`);
  log.warn(`xiaozhi: ${session.deviceId} unknown mcp method '${method}'`);
}
