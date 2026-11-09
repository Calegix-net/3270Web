#!/usr/bin/env bash
# Build the image and run scripts/check-base-path.mjs against it, twice: under a
# path prefix behind a real nginx terminating TLS, and at the root with no proxy.
#
#   scripts/check-base-path.sh [prefix]        # default /3270
#
# Everything it creates is named bp-* and is removed on exit. The only port it
# publishes is a random high one on loopback, for the proxy.
#
# Options (environment variables):
#   CONTAINER_CLI   podman or docker (default podman)
#   CHECK_OUT_DIR   where results and screenshots go (default ./output/base-path)
#   CHECK_IMAGE     use this image instead of building one
set -euo pipefail

cli="${CONTAINER_CLI:-podman}"
prefix="${1:-/3270}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="${CHECK_OUT_DIR:-$root/output/base-path}"
mkdir -p "$out"
work="$(mktemp -d)"
port="$(shuf -i 20000-60000 -n 1)"
playwright_image="mcr.microsoft.com/playwright:v1.55.0-noble"
image="${CHECK_IMAGE:-bp-3270web:check}"

cleanup() {
  "$cli" rm -f -t 2 bp-app bp-sampleapps bp-nginx bp-playwright bp-cert >/dev/null 2>&1 || true
  "$cli" volume rm -f bp-data bp-npm >/dev/null 2>&1 || true
  "$cli" network rm -f bp-net >/dev/null 2>&1 || true
  [ -n "${CHECK_IMAGE:-}" ] || "$cli" rmi -f "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

[ -n "${CHECK_IMAGE:-}" ] || "$cli" build -t "$image" "$root"

"$cli" network create bp-net >/dev/null
"$cli" volume rm -f bp-npm >/dev/null 2>&1 || true
"$cli" volume create bp-npm >/dev/null

"$cli" run -d --name bp-sampleapps --network bp-net "$image" \
  sampleapp --app petstore:3271 --app app1:3272 >/dev/null

# Waits for the setup code in the server log, and keeps it out of everything but
# the variable: it is a credential for the length of this run.
start_app() {
  "$cli" rm -f -t 2 bp-app >/dev/null 2>&1 || true
  "$cli" volume rm -f bp-data >/dev/null 2>&1 || true
  "$cli" volume create bp-data >/dev/null
  "$cli" run -d --name bp-app --network bp-net -v bp-data:/data \
    -e GIN_MODE=release -e AUTH_MODE=local -e ALLOW_SAMPLE_APPS=1 "$@" "$image" >/dev/null
  setup_code=""
  for _ in $(seq 1 60); do
    setup_code="$("$cli" logs bp-app 2>&1 | sed -n 's/.*auth: setup code: \([A-Z0-9-]*\).*/\1/p' | tail -1)"
    [ -n "$setup_code" ] && return 0
    sleep 0.5
  done
  echo "no setup code appeared in the server log" >&2
  return 1
}

run_browser() {
  # $1 is where the browser joins the network; the rest are its environment.
  local netns="$1"
  shift
  CHECK_SETUP_CODE="$setup_code" "$cli" run --rm --name bp-playwright --init --ipc=host \
    --network "container:$netns" \
    -v "$here:/scripts:ro,Z" -v "$out:/out:Z" -v bp-npm:/deps \
    -e CHECK_SETUP_CODE -e CHECK_OUT_DIR=/out "$@" "$playwright_image" \
    bash -c 'cd /deps && { [ -d node_modules/playwright ] || npm install --silent --no-audit --no-fund playwright@1.55.0 >/dev/null; } &&
      cp /scripts/check-base-path.mjs . && node check-base-path.mjs'
}

# ------------------------------------------------------------- under a prefix

"$cli" run --rm -v "$work:/w:Z" docker.io/library/golang:1.26 \
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
  -keyout /w/key.pem -out /w/cert.pem >/dev/null 2>&1
chmod 644 "$work"/*.pem
sed -e "s|@PORT@|$port|g; s|@PREFIX@|$prefix|g; s|@BACKEND@|bp-app:3270|g" \
  "$here/check-base-path.nginx.conf" >"$work/nginx.conf"

start_app -e BASE_PATH="$prefix" -e TRUST_PROXY_HEADERS=true -e EMBED_ORIGINS=https://parent.example

"$cli" run -d --name bp-nginx --network bp-net -p "127.0.0.1:$port:$port" \
  -v "$work:/etc/nginx/check:ro,Z" docker.io/library/nginx:stable-alpine \
  nginx -c /etc/nginx/check/nginx.conf -g 'daemon off;' >/dev/null

status=0
run_browser bp-nginx -e CHECK_BASE_URL="https://localhost:$port$prefix" \
  -e CHECK_TN3270_HOST=bp-sampleapps -e CHECK_MODE=full || status=$?

"$cli" exec bp-app curl -fsS http://127.0.0.1:3270/healthz >/dev/null \
  && echo "ok    unprefixed /healthz answers inside the container" \
  || { echo "FAIL  unprefixed /healthz"; status=1; }

outside="$("$cli" exec bp-nginx sh -c 'cat /var/log/nginx/outside.log 2>/dev/null' | sed 's/\?.*//' )"
echo "requests nginx refused outside $prefix: $(printf '%s' "$outside" | grep -c . || true)"
printf '%s\n' "$outside" | sed '/^$/d' >"$out/outside-prefix.log"
[ -z "$outside" ] || { echo "FAIL  requests left the prefix:"; printf '%s\n' "$outside"; status=1; }
echo "requests nginx served inside $prefix: $("$cli" exec bp-nginx sh -c 'wc -l </var/log/nginx/inside.log')"

# The API and MCP surface, with a token, through the proxy.
token="$("$cli" exec bp-app /app/3270Web token add checkadmin mcp 2>/dev/null | grep -Eo '[A-Za-z0-9_-]{24,}' | tail -1 || true)"
if [ -n "$token" ]; then
  code="$("$cli" exec bp-nginx curl -ks -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "https://localhost:$port$prefix/api/v1/sessions")"
  echo "GET $prefix/api/v1/sessions with a token: $code"
  [ "$code" = 200 ] || status=1
  mcp="$("$cli" exec bp-nginx curl -ks -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
    "https://localhost:$port$prefix/api/v1/mcp" | tr -d '\r' | grep -c serverInfo || true)"
  echo "POST $prefix/api/v1/mcp initialize answered: $mcp"
  [ "$mcp" != 0 ] || status=1
else
  echo "FAIL  could not issue an API token"
  status=1
fi

refused="$("$cli" logs bp-app 2>&1 | grep -c 'CSRF protection' || true)"
echo "CSRF refusals in the server log: $refused"
[ "$refused" = 0 ] || status=1

"$cli" rm -f -t 2 bp-nginx >/dev/null

# ----------------------------------------------------------------- at the root

start_app
run_browser bp-app -e CHECK_BASE_URL=http://127.0.0.1:3270 \
  -e CHECK_TN3270_HOST=bp-sampleapps -e CHECK_MODE=smoke || status=$?

exit "$status"
