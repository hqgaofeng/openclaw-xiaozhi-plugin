/**
 * xiaozhi-esp32 OTA endpoint (M3.5 V2 #8 移植)
 *
 * esp32 firmware boots → POST /api/xiaozhi/ota/ with device info
 * JSON body → we return config including the WS server URL.
 * esp32 then WebSocket-Connects the URL we told it.
 *
 * Source: xiaozhi-esp32 main/ota.cc ::Ota::CheckVersion()
 *   - Reads NVS `wifi.ota_url` (or CONFIG_OTA_URL fallback)
 *   - Sends device info JSON body via POST
 *   - Parses response, writes `websocket` section to NVS namespace "websocket"
 *   - The websocket_protocol then reads websocket.url from NVS "websocket"
 *     namespace — which is how the firmware picks up our WS URL on reboot.
 *
 * V2 #8.1 fix: REMOVE the activation section entirely. The xiaozhi-esp32
 * main/ota.cc CheckVersion() reads `cJSON* code = cJSON_GetObjectItem(activation, "code")`
 * and treats "00:00:00" as a real activation code → enters ShowActivationCode
 * infinite loop (10x Activate() failures). Omit activation → both
 * has_activation_code_ and has_activation_challenge_ stay false → outer
 * while breaks → InitializeProtocol runs → idle → waits for wake word.
 *
 * M3.5: ported from V2 bridge/api/main.py to V3 plugin via openclaw's
 * api.registerHttpRoute() contract. The handler shape is plain Node
 * (req, res) — we parse the body manually because openclaw's
 * registerHttpRoute passes the raw IncomingMessage / ServerResponse.
 *
 * Authentication: `auth: "plugin"` — the route is exposed under the
 * plugin's namespace; we don't need a separate token because the
 * esp32 firmware already knows our public URL (and we don't want to
 * burn a token in NVS where it's recoverable). For non-esp32 callers
 * (scrapers / accidental hits), the response still doesn't expose
 * any sensitive state.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Public WS URL the device should connect to. */
const OTA_WEBSOCKET_URL = "wss://jarvis.beallen.top/xiaozhi/v1/";

/** Firmware version we tell the device to stay on. Bump to push updates. */
const OTA_FIRMWARE_VERSION = "2.2.6";

/** Beijing timezone. */
const TIMEZONE_OFFSET_MINUTES = 8 * 60;

const MAX_BODY_BYTES = 8 * 1024; // 8 KiB — device info is < 1 KiB

/**
 * V2 #8.1 response shape (matches xiaozhi-esp32 main/ota.cc parser).
 *
 * Note: NO `activation` field. The esp32 firmware will see the absent
 * field and skip the activation flow entirely.
 */
interface OtaResponse {
  websocket: { url: string };
  server_time: {
    timestamp: number;
    timezone: string;
    timezone_offset_minutes: number;
  };
  firmware: {
    version: string;
    url: string;
  };
}

/**
 * Read the request body into a UTF-8 string. We support both POST (with
 * JSON body) and GET (no body). Returns null on error.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    if (req.method === "GET" || req.method === "HEAD") {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

interface OtaDeviceInfo {
  board?: string;
  mac_address?: string;
  flash_size?: number;
  psram_size?: number;
  version?: number;
  language?: string;
}

/**
 * The actual HTTP route handler. Registered via openclaw's
 * api.registerHttpRoute({ path: "/api/xiaozhi/ota/", handler, auth: "plugin" }).
 *
 * Method support: POST (real device), GET (curl sanity check / scrapers).
 */
export async function handleOtaRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const bodyText = await readBody(req);

  // Parse device info (best-effort; we don't validate in V2 #8 minimal).
  let device: OtaDeviceInfo = {};
  if (bodyText && bodyText.length > 0) {
    try {
      device = JSON.parse(bodyText) as OtaDeviceInfo;
    } catch (err) {
      console.warn(`[xiaozhi.ota] body parse failed: ${(err as Error).message} body=${bodyText.slice(0, 200)}`);
    }
  }

  if (device.mac_address || device.board) {
    // M3.7.3: device.board from the xiaozhi-esp32 firmware is a nested
    // JSON object (e.g. {type: "my-custom-wifi-lcd", ...}) rather than
    // a plain string. Without JSON.stringify it logged as
    // "board=[object Object]" which made it impossible to tell which
    // board we were actually being called by.
    const boardDesc =
      typeof device.board === "string"
        ? device.board
        : device.board != null
        ? JSON.stringify(device.board)
        : "unknown";
    console.log(
      `[xiaozhi.ota] check from board=${boardDesc} ` +
        `mac=${device.mac_address ?? "unknown"} ` +
        `flash=${device.flash_size ?? "?"} → ${OTA_WEBSOCKET_URL}`,
    );
  } else {
    console.log(`[xiaozhi.ota] check (no body) from ${req.socket.remoteAddress ?? "?"}`);
  }

  const response: OtaResponse = {
    websocket: { url: OTA_WEBSOCKET_URL },
    server_time: {
      timestamp: Date.now(),
      timezone: "Asia/Shanghai",
      timezone_offset_minutes: TIMEZONE_OFFSET_MINUTES,
    },
    firmware: {
      version: OTA_FIRMWARE_VERSION,
      url: "",
    },
  };

  sendJson(res, 200, response);
}
