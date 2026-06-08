#!/bin/bash
# enable_xiaozhi_auth.sh
#
# M3.6 (v0.3.1) — one-shot helper to add a device_id → bearer-token
# entry to /root/.openclaw/openclaw.json under
# `channels.xiaozhi.authTokens`.
#
# V3 plugin reuses V2 #6.1 (v0.2.7) auth logic: per-device token OR
# global auth token, with auth disabled (V2 #5 compatibility) when
# both are empty.
#
# Usage (on the VPS):
#
#   sudo /root/projects/openclaw-xiaozhi-plugin/scripts/enable_xiaozhi_auth.sh [device_id] [token]
#
# Examples:
#
#   # Generate a fresh per-device token for esp32-001:
#   sudo ./scripts/enable_xiaozhi_auth.sh esp32-001 "$(openssl rand -hex 24)"
#
#   # Set a single global auth token (any device with this token is allowed):
#   sudo ./scripts/enable_xiaozhi_auth.sh --global "$(openssl rand -hex 24)"
#
#   # Look up device_ids via the API:
#   curl -s http://127.0.0.1:18790/api/xiaozhi/devices 2>/dev/null
#   # (or the openclaw API once a tool is registered)
#
# What it does:
#   1. Validates inputs (no spaces, no 'Bearer ' prefix).
#   2. Backs up openclaw.json to /root/.openclaw/openclaw.json.bak.YYYY-MM-DD-HHMMSS.
#   3. Inserts/updates the entry under channels.xiaozhi.authTokens
#      (or sets channels.xiaozhi.globalAuthToken for --global).
#   4. Prints the diff.
#   5. openclaw auto-reloads on cp (see M3.4g) — no restart needed.
#
# Rollback:
#   sudo cp /root/.openclaw/openclaw.json.bak.YYYY-MM-DD-HHMMSS \
#            /root/.openclaw/openclaw.json
#
# Why opt-in?
#   - esp32 firmware is currently NOT sending Authorization header.
#     Enabling auth before patching firmware will cause esp32 to
#     disconnect with 'no_token' reason.
#   - Workflow: (a) update firmware to send Authorization header
#               (b) enable auth on openclaw.json
#               (c) reload openclaw (automatic on file change)
#               (d) esp32 reconnects → auth verified
#
#   For testing only: pass --global to set a global token, then
#   have the firmware send that one token regardless of device.
#
# Why not a python script?
#   - It's a 5-line JSON edit; sed+python is fine.
#   - Keeps it readable; operator can edit by hand if needed.
#   - No new tool to learn.

set -euo pipefail

CONFIG="/root/.openclaw/openclaw.json"

# --- Parse args ---
MODE="device"
if [[ "${1:-}" == "--global" ]]; then
    MODE="global"
    if [[ $# -ne 2 ]]; then
        echo "Usage: $0 --global <token>" >&2
        exit 1
    fi
    TOKEN="$2"
    DEVICE_ID=""
elif [[ $# -eq 2 ]]; then
    MODE="device"
    DEVICE_ID="$1"
    TOKEN="$2"
else
    cat >&2 <<EOF
Usage:
  $0 <device_id> <token>      # per-device token
  $0 --global <token>         # global auth token

  device_id  the ESP32's Device-Id header value (e.g. esp32-001,
             a MAC, or any string the firmware sets).
  token      the bearer token the firmware will send in
             'Authorization: Bearer <token>'. No 'Bearer ' prefix,
             no spaces. Use: openssl rand -hex 24
EOF
    exit 1
fi

# --- Sanity: shape of inputs ---
if [[ "$MODE" == "device" ]]; then
    if [[ ! "$DEVICE_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
        echo "ERROR: device_id must match [A-Za-z0-9._:-]+ (got: '$DEVICE_ID')" >&2
        exit 1
    fi
fi
if [[ ! "$TOKEN" =~ ^[A-Za-z0-9._/+=-]+$ ]]; then
    echo "ERROR: token must match [A-Za-z0-9._/+=-]+ (got: '$TOKEN')" >&2
    echo "  Generate one with: openssl rand -hex 24" >&2
    exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
    echo "ERROR: openclaw.json not found at $CONFIG" >&2
    exit 1
fi

# --- Backup ---
TS=$(date +%Y%m%d-%H%M%S)
BAK="$CONFIG.bak.$TS"
cp "$CONFIG" "$BAK"
echo "==> backed up to $BAK"

# --- Patch ---
if [[ "$MODE" == "global" ]]; then
    python3 - "$CONFIG" "$TOKEN" <<'PYEOF'
import json, sys
cfg, tok = sys.argv[1], sys.argv[2]
with open(cfg) as f:
    data = json.load(f)
data.setdefault("channels", {}).setdefault("xiaozhi", {})["globalAuthToken"] = tok
with open(cfg, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
else
    python3 - "$CONFIG" "$DEVICE_ID" "$TOKEN" <<'PYEOF'
import json, sys
cfg, dev, tok = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cfg) as f:
    data = json.load(f)
tokens = data.setdefault("channels", {}).setdefault("xiaozhi", {}).setdefault("authTokens", {})
tokens[dev] = tok
with open(cfg, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
fi

echo
echo "==> diff ($BAK -> $CONFIG):"
diff "$BAK" "$CONFIG" || true
echo
echo "==> DONE."
echo
if [[ "$MODE" == "global" ]]; then
    echo "Global auth token set. Any device sending"
echo "  Authorization: Bearer $TOKEN"
echo "will be accepted. Devices without a token will be rejected."
else
    echo "Per-device token set for device_id='$DEVICE_ID'."
echo "Firmware must send:"
echo "  Authorization: Bearer $TOKEN"
echo "on every WebSocket connect."
fi
echo
echo "openclaw will auto-reload openclaw.json in ~1s. No manual"
echo "restart needed. Verify with:"
echo "  journalctl --user -u openclaw-gateway -n 30 | grep xiaozhi"
