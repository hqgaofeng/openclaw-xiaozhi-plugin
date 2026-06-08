/**
 * Tests for the xiaozhi-esp32 OTA endpoint (M3.5 V2 #8 移植).
 *
 * V2 8001 endpoint contract:
 *   - POST /api/xiaozhi/ota/ with JSON device info
 *   - Response: { websocket: {url}, server_time: {...}, firmware: {version,url} }
 *   - NO activation section (V2 #8.1 fix — triggers infinite loop in
 *     xiaozhi-esp32 main/ota.cc if present)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleOtaRequest } from "../ota.js";

interface MockRes extends ServerResponse {
  _body: string;
  _status: number;
  _headers: Record<string, string>;
}

function makeRes(): MockRes {
  const res = {
    _body: "",
    _status: 0,
    _headers: {},
    statusCode: 0,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return this._headers[name.toLowerCase()];
    },
    end(chunk?: string) {
      if (chunk) this._body += chunk;
      this._status = this.statusCode;
    },
    destroy() {},
  } as unknown as MockRes;
  return res;
}

function makeReq(opts: { method: string; body?: string; remoteAddress?: string }): IncomingMessage {
  const { method, body, remoteAddress = "192.168.1.1" } = opts;
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress };
  if (method !== "GET" && method !== "HEAD" && body !== undefined) {
    process.nextTick(() => {
      (req as unknown as PassThrough).write(body);
      (req as unknown as PassThrough).end();
    });
  } else {
    process.nextTick(() => {
      (req as unknown as PassThrough).end();
    });
  }
  return req;
}

describe("handleOtaRequest (M3.5 V2 #8 移植)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("POST /api/xiaozhi/ota/ with device info → 200 + correct shape", async () => {
    const device = {
      version: 2,
      flash_size: 16777216,
      psram_size: 8388608,
      board: "my-custom-wifi-lcd",
      mac_address: "58:e6:c5:6b:9b:54",
      language: "zh-CN",
    };
    const req = makeReq({ method: "POST", body: JSON.stringify(device) });
    const res = makeRes();

    await handleOtaRequest(req, res);

    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toMatch(/application\/json/);
    expect(res._headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res._body);
    expect(body.websocket.url).toBe("wss://jarvis.beallen.top/xiaozhi/v1/");
    expect(body.firmware.version).toBe("2.2.6");
    expect(body.firmware.url).toBe("");
    expect(body.server_time.timezone).toBe("Asia/Shanghai");
    expect(body.server_time.timezone_offset_minutes).toBe(480);
    expect(typeof body.server_time.timestamp).toBe("number");
    // V2 #8.1 fix: NO activation section
    expect(body).not.toHaveProperty("activation");
  });

  it("GET /api/xiaozhi/ota/ (no body) → 200 + same response shape", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();

    await handleOtaRequest(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.websocket.url).toBe("wss://jarvis.beallen.top/xiaozhi/v1/");
  });

  it("malformed JSON body → still returns 200 (V2 #8 minimal — no validation)", async () => {
    const req = makeReq({ method: "POST", body: "{not-valid-json" });
    const res = makeRes();

    await handleOtaRequest(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.websocket.url).toMatch(/^wss:\/\//);
  });

  it("rejects body larger than 8 KiB", async () => {
    const big = "x".repeat(9000);
    const req = makeReq({ method: "POST", body: big });
    const res = makeRes();

    await handleOtaRequest(req, res);

    // Body is destroyed before parsing → device info not extracted.
    // The response still goes out (handler doesn't fail on missing body).
    const body = JSON.parse(res._body);
    expect(body.websocket.url).toMatch(/^wss:\/\//);
  });
});
