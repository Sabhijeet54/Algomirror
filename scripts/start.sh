#!/bin/sh
# Starts the whole platform in one container. Only secrets, database and broker keys
# need to be set as variables — everything else is derived from the public domain.
set -e

DOMAIN="${PUBLIC_DOMAIN:-${RENDER_EXTERNAL_HOSTNAME:-$RAILWAY_PUBLIC_DOMAIN}}"
if [ -z "$DOMAIN" ]; then echo "Set PUBLIC_DOMAIN (Render sets RENDER_EXTERNAL_HOSTNAME automatically)"; exit 1; fi
ORIGIN="https://$DOMAIN"

export NODE_ENV=production
export APP_ENV="${APP_ENV:-production}"
export COOKIE_SECURE="${COOKIE_SECURE:-true}"
export TRUST_PROXY="${TRUST_PROXY:-true}"
export PAPER_MODE="${PAPER_MODE:-true}"
export WEB_ORIGIN="${WEB_ORIGIN:-$ORIGIN}"
export API_PUBLIC_URL="${API_PUBLIC_URL:-$ORIGIN/api}"
export API_INTERNAL_URL="http://127.0.0.1:4000"
export ZERODHA_REDIRECT_URL="${ZERODHA_REDIRECT_URL:-$ORIGIN/api/brokers/zerodha/callback}"
export ANGEL_REDIRECT_URL="${ANGEL_REDIRECT_URL-$ORIGIN/api/brokers/angel-one/callback}"
WEB_PORT="${PORT:-3000}"

echo "Public URL:        $ORIGIN"
echo "Zerodha redirect:  $ZERODHA_REDIRECT_URL"
echo "Angel redirect:    $ANGEL_REDIRECT_URL"

npm run prisma:deploy

# Start API + web as plain node processes. The old "npx concurrently" + "npm run start" wrappers kept four extra
# npm/node processes alive (~260 MB) — together over 512 MB, so the instance ran out of memory and crashed.
# Heap caps keep each process inside the plan's RAM (override with API_HEAP_MB / WEB_HEAP_MB).
API_HEAP_MB="${API_HEAP_MB:-256}"
WEB_HEAP_MB="${WEB_HEAP_MB:-160}"

(cd apps/api && PORT=4000 exec node --max-old-space-size="$API_HEAP_MB" dist/main.js) &
API_PID=$!
(cd apps/web && PORT="$WEB_PORT" exec node --max-old-space-size="$WEB_HEAP_MB" ../../node_modules/next/dist/bin/next start --port "$WEB_PORT") &
WEB_PID=$!

stop() { kill "$API_PID" "$WEB_PID" 2>/dev/null; wait; }
trap 'stop; exit 0' TERM INT

# If either process dies, stop the other and exit non-zero so the host restarts the whole service.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 5; done
echo "A process exited — restarting the service"
stop
exit 1
