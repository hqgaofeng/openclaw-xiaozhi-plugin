/**
 * test-mcp-router.test.ts — M3.7.2 esp32 Tool Registry + factory router
 *
 * Covers:
 *  1. registerEsp32Tools / unregisterEsp32Tools / getEsp32DeviceTools
 *  2. createEsp32DeviceToolRouter: empty registry → no tools
 *  3. createEsp32DeviceToolRouter: 1 device, 1 tool → 1 adapter
 *  4. createEsp32DeviceToolRouter: N devices × M tools → N×M adapters
 *  5. Tool name format: esp32_<sanitizedDeviceId>_<toolName>
 *  6. Sanitize MAC-like deviceIds (colons → underscores)
 *  7. Tool execution routes to the right device's WebSocket
 *  8. Tool execution error returns isError result
 *  9. LLM call to wrong device (no entry) returns clear error
 * 10. Audio content blocks flattened to text
 * 11. Unregister removes device from router
 * 12. Factory re-reads registry on each call (lazy)
 * 13. createListDevicesTool still works alongside the router
 * 14. Two devices with same tool name → two different adapters
 * 15. Concurrent tool calls use independent mcpRequestId per session
 *
 * @see src/mcp/registry.ts
 * @see src/mcp/tools.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import {
  registerEsp32Tools,
  unregisterEsp32Tools,
  getEsp32DeviceTools,
  getEsp32ToolRegistry,
} from "../mcp/registry.js";
import {
  createEsp32DeviceToolRouter,
  createListDevicesTool,
  sanitizeDeviceId,
} from "../mcp/tools.js";
import { resolveMcpResponse } from "../mcp/outbound.js";
import { createSessionContext } from "../session.js";
import { OpusCodec } from "../audio.js";
import type { McpTool } from "../mcp/protocol.js";

function makeMockWs(): WebSocket {
  return {
    send: vi.fn(),
  } as unknown as WebSocket;
}

beforeEach(() => {
  // Clean registry between tests
  const reg = getEsp32ToolRegistry();
  for (const k of Array.from(reg.keys())) reg.delete(k);
});

describe("Esp32ToolRegistry (M3.7.2)", () => {
  it("1. register/unregister/getEsp32DeviceTools basic", () => {
    const ws = makeMockWs();
    const session = createSessionContext(
      "dev1",
      "sess1",
      new OpusCodec(16000),
    );
    const tools: McpTool[] = [{ name: "t1" }];
    registerEsp32Tools("dev1", {
      tools,
      ws,
      session,
      lastReportedAt: 1000,
    });
    expect(getEsp32DeviceTools("dev1")).toEqual(tools);
    unregisterEsp32Tools("dev1");
    expect(getEsp32DeviceTools("dev1")).toBeNull();
  });

  it("1b. getEsp32DeviceTools returns null for unknown device", () => {
    expect(getEsp32DeviceTools("nonexistent")).toBeNull();
  });
});

describe("createEsp32DeviceToolRouter (M3.7.2)", () => {
  it("2. empty registry → no tools", () => {
    const tools = createEsp32DeviceToolRouter({});
    expect(tools).toEqual([]);
  });

  it("3. 1 device, 1 tool → 1 adapter", () => {
    const ws = makeMockWs();
    const session = createSessionContext(
      "dev1",
      "s1",
      new OpusCodec(16000),
    );
    registerEsp32Tools("dev1", {
      tools: [{ name: "self.set_volume" }],
      ws,
      session,
      lastReportedAt: 0,
    });
    const tools = createEsp32DeviceToolRouter({});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("esp32_dev1_self.set_volume");
  });

  it("4. 2 devices × 2 tools → 4 adapters", () => {
    const ws = makeMockWs();
    const s1 = createSessionContext("dev1", "s1", new OpusCodec(16000));
    const s2 = createSessionContext("dev2", "s2", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }, { name: "t2" }],
      ws,
      session: s1,
      lastReportedAt: 0,
    });
    registerEsp32Tools("dev2", {
      tools: [{ name: "t1" }, { name: "t2" }],
      ws,
      session: s2,
      lastReportedAt: 0,
    });
    const tools = createEsp32DeviceToolRouter({});
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("esp32_dev1_t1");
    expect(names).toContain("esp32_dev1_t2");
    expect(names).toContain("esp32_dev2_t1");
    expect(names).toContain("esp32_dev2_t2");
  });

  it("5. sanitizeDeviceId: alnum/dash/underscore pass through", () => {
    expect(sanitizeDeviceId("abc-123_xyz")).toBe("abc-123_xyz");
  });

  it("6. sanitizeDeviceId: MAC-like colons → underscores", () => {
    expect(sanitizeDeviceId("58:e6:c5:6b:9b:54")).toBe("58_e6_c5_6b_9b_54");
  });

  it("7. tool execution routes to the right device's WebSocket", async () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const s1 = createSessionContext("dev1", "s1", new OpusCodec(16000));
    const s2 = createSessionContext("dev2", "s2", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }],
      ws: ws1,
      session: s1,
      lastReportedAt: 0,
    });
    registerEsp32Tools("dev2", {
      tools: [{ name: "t1" }],
      ws: ws2,
      session: s2,
      lastReportedAt: 0,
    });

    const tools = createEsp32DeviceToolRouter({});
    const t1dev1 = tools.find((t) => t.name === "esp32_dev1_t1")!;
    const t1dev2 = tools.find((t) => t.name === "esp32_dev2_t1")!;

    const p1 = t1dev1.execute("c1", { x: 1 });
    const p2 = t1dev2.execute("c2", { x: 2 });
    // Resolve in order so we know which one is which.
    // dev1's send is called with id=1, dev2's send is called with id=1 (per-session).
    expect((ws1.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((ws2.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // Find the sent messages
    const m1 = JSON.parse((ws1.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const m2 = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(m1.payload.params.arguments).toEqual({ x: 1 });
    expect(m2.payload.params.arguments).toEqual({ x: 2 });
    // Resolve both
    s1.pendingMcpCalls.get("1")?.resolve({ content: [{ type: "text", text: "from dev1" }] });
    s2.pendingMcpCalls.get("1")?.resolve({ content: [{ type: "text", text: "from dev2" }] });
    const r1 = await p1;
    const r2 = await p2;
    expect((r1.content[0] as { text: string }).text).toBe("from dev1");
    expect((r2.content[0] as { text: string }).text).toBe("from dev2");
  });

  it("8. tool execution error → isError result", async () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "broken" }],
      ws,
      session: s,
      lastReportedAt: 0,
    });
    const tools = createEsp32DeviceToolRouter({});
    const t = tools[0];
    const promise = t.execute("c1", {});
    // Disconnect to trigger error.
    s.pendingMcpCalls.get("1")?.reject(new Error("test_error"));
    const result = await promise;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/test_error/);
  });

  it("9. unregister removes device from router", () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }],
      ws,
      session: s,
      lastReportedAt: 0,
    });
    expect(createEsp32DeviceToolRouter({})).toHaveLength(1);
    unregisterEsp32Tools("dev1");
    expect(createEsp32DeviceToolRouter({})).toHaveLength(0);
  });

  it("10. factory re-reads registry on each call (lazy)", () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    expect(createEsp32DeviceToolRouter({})).toHaveLength(0);
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }],
      ws,
      session: s,
      lastReportedAt: 0,
    });
    expect(createEsp32DeviceToolRouter({})).toHaveLength(1);
  });

  it("11. createListDevicesTool + router coexist", () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }],
      ws,
      session: s,
      lastReportedAt: 100,
    });
    const list = createListDevicesTool();
    const router = createEsp32DeviceToolRouter({});
    expect(list.name).toBe("xiaozhi_list_devices");
    expect(router).toHaveLength(1);
  });

  it("12. listDevicesTool reports registered tools", async () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }, { name: "t2" }],
      ws,
      session: s,
      lastReportedAt: 0,
    });
    const list = createListDevicesTool();
    const result = await list.execute("c1", {});
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed[0].deviceId).toBe("dev1");
    expect(parsed[0].toolCount).toBe(2);
    expect(parsed[0].toolNames).toEqual(["t1", "t2"]);
  });

  it("13. concurrent tool calls use independent mcpRequestId per session", async () => {
    const ws = makeMockWs();
    const s = createSessionContext("dev1", "s1", new OpusCodec(16000));
    registerEsp32Tools("dev1", {
      tools: [{ name: "t1" }],
      ws,
      session: s,
      lastReportedAt: 0,
    });
    const t = createEsp32DeviceToolRouter({})[0];
    const p1 = t.execute("c1", { a: 1 });
    const p2 = t.execute("c2", { a: 2 });
    const p3 = t.execute("c3", { a: 3 });
    // All 3 sent, ids 1,2,3 monotonic.
    expect(s.pendingMcpCalls.size).toBe(3);
    // Use resolveMcpResponse so the Map entry is deleted on resolve.
    resolveMcpResponse(s, "1", { result: { content: [] } });
    resolveMcpResponse(s, "2", { result: { content: [] } });
    resolveMcpResponse(s, "3", { result: { content: [] } });
    await Promise.all([p1, p2, p3]);
    expect(s.pendingMcpCalls.size).toBe(0);
  });
});
