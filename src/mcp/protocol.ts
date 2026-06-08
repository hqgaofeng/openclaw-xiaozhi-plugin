/**
 * MCP protocol types — xiaozhi JSON-RPC 2.0 over WebSocket.
 *
 * Mirrors bridge/src/xiaozhi_bridge/mcp/ (V2 #7 + V2 #11a) but
 * expressed in TypeScript with strict types.
 *
 * @see https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
 * @see docs/protocol.md §5
 */

/** JSON-RPC 2.0 envelope — used for all MCP messages. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/** xiaozhi MCP methods we know about. */
export const MCP_METHODS = {
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

export type McpMethod = (typeof MCP_METHODS)[keyof typeof MCP_METHODS];

/** Tool definition (from esp32 tools/list response). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Tool call params (server → esp32 in tools/call request). */
export interface McpToolsCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool call result (esp32 → server in JSON-RPC result). */
export interface McpToolsCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** Convert MCP tool list to OpenAI chat completions function-calling shape. */
export function toOpenAiFunctionShape(
  tool: McpTool,
): {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: McpTool["inputSchema"];
  };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? `ESP32 device tool: ${tool.name}`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

/** Type guards for JSON-RPC envelopes. */
export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (msg as JsonRpcRequest).method !== undefined;
}

export function isJsonRpcResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcResponse {
  const r = msg as JsonRpcResponse;
  return (r as JsonRpcResponseSuccess).result !== undefined || (r as JsonRpcResponseError).error !== undefined;
}

export function isJsonRpcSuccess(
  msg: JsonRpcResponse,
): msg is JsonRpcResponseSuccess {
  return (msg as JsonRpcResponseSuccess).result !== undefined;
}

export function isJsonRpcError(
  msg: JsonRpcResponse,
): msg is JsonRpcResponseError {
  return (msg as JsonRpcResponseError).error !== undefined;
}
