#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DEMO_DATA=${EKIP_DEMO_DATA:-"$ROOT/hub/demo/.data"}
node "$ROOT/hub/demo/seed.mjs" "$DEMO_DATA"
# --terminal: the terminal GIFs, MP4 and stills in docs/demo and docs/screenshots (no server needed)
if [ "${1:-}" = "--terminal" ]; then shift; exec node "$ROOT/hub/demo/terminal-demo.mjs" "$@"; fi
if [ ! -d "$ROOT/hub/public/assets" ]; then (cd "$ROOT/hub/web" && pnpm build); fi
cd "$ROOT/hub"
export EKIP_DEMO=1 EKIP_DATA="$DEMO_DATA" PORT="${PORT:-7790}" HOST=127.0.0.1 EKIP_HUB_TOKEN=demo-token-for-local-development EKIP_HUB_PASSWORD=demo EKIP_HUB_SECRET=demo-secret-only-local EKIP_HUB_COMMIT=abc1234 FREELLMAPI_URL= TDAI_PROXY_URL=
if [ "${1:-}" = "--capture" ]; then
  node src/server.js &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
  i=0
  until curl -fsS "http://127.0.0.1:$PORT/" >/dev/null; do
    i=$((i + 1)); [ "$i" -lt 40 ] || { echo "demo server did not start" >&2; exit 1; }
    sleep 0.25
  done
  node "$ROOT/hub/demo/capture.mjs"
  node "$ROOT/hub/demo/screenshots.mjs"
else
  exec node src/server.js
fi
