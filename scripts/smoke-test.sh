#!/usr/bin/env bash
# Smoke-test the built esa-dono-ui containers to ensure they actually run and
# serve traffic — not just that the images build.
#
# Assumes the backend and frontend images are already built and tagged as the
# names used in docker-compose.yml:
#   ghcr.io/esamarathon/esa-dono-ui/backend:${BACKEND_IMAGE_TAG:-latest}
#   ghcr.io/esamarathon/esa-dono-ui/frontend:${FRONTEND_IMAGE_TAG:-latest}
#
# Usage:
#   scripts/smoke-test.sh                 # uses docker compose, FRONTEND_PORT=18080
#   FRONTEND_PORT=9090 scripts/smoke-test.sh
#   BACKEND_IMAGE_TAG=<sha> FRONTEND_IMAGE_TAG=<sha> scripts/smoke-test.sh
#     # test a specific build (e.g. the one just pushed for a non-main branch)
#     # instead of whatever :latest currently resolves to.
#
# Requires: docker (or a docker-compatible CLI) + curl.
# Exits non-zero on the first failed check and always tears the stack down.

set -euo pipefail

ADMIN_API_KEY="${ADMIN_API_KEY:-smoke-test-key}"
FRONTEND_PORT="${FRONTEND_PORT:-18080}"
BACKEND_IMAGE_TAG="${BACKEND_IMAGE_TAG:-latest}"
FRONTEND_IMAGE_TAG="${FRONTEND_IMAGE_TAG:-latest}"
BASE="http://localhost:${FRONTEND_PORT}"
COMPOSE="docker compose"

export ADMIN_API_KEY FRONTEND_PORT BACKEND_IMAGE_TAG FRONTEND_IMAGE_TAG

cleanup() {
  echo "==> Tearing down stack"
  $COMPOSE down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- backend logs -----" >&2
  $COMPOSE logs dono-backend 2>&1 | tail -40 >&2 || true
  echo "----- frontend logs -----" >&2
  $COMPOSE logs dono-frontend 2>&1 | tail -40 >&2 || true
  exit 1
}

# Wait for an HTTP endpoint to return a given status, retrying up to N times.
wait_for() {
  local url="$1" want="$2" tries="${3:-30}" got
  for _ in $(seq 1 "$tries"); do
    got="$(curl -s -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  return 1
}

echo "==> Starting stack (frontend on :${FRONTEND_PORT})"
$COMPOSE up -d

echo "==> 1. Backend health (through nginx /api proxy)"
wait_for "${BASE}/api/health" 200 45 || fail "backend /api/health never became healthy"
health="$(curl -s "${BASE}/api/health")"
echo "    $health"
echo "$health" | grep -q '"ok":true' || fail "health payload not ok: $health"

echo "==> 2. Frontend serves SPA index"
wait_for "${BASE}/" 200 15 || fail "frontend index not served"

echo "==> 3. SPA fallback for client-side route"
wait_for "${BASE}/rewards" 200 5 || fail "SPA fallback route did not return index"

echo "==> 4. Admin auth is enforced (401 without key)"
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/stats")"
[ "$code" = "401" ] || fail "expected 401 without admin key, got $code"

echo "==> 5. Admin auth succeeds with key (200)"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer key_admin_${ADMIN_API_KEY}" "${BASE}/api/admin/stats")"
[ "$code" = "200" ] || fail "expected 200 with admin key, got $code"

echo "==> 6. End-to-end write path: simulate a donation (proves migrations + DB writes)"
resp="$(curl -s -X POST "${BASE}/api/admin/simulate-donation" \
  -H "Authorization: Bearer key_admin_${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.com","amount_cents":2500}')"
echo "    $resp"
echo "$resp" | grep -q '"success":true' || fail "simulate-donation did not succeed: $resp"

echo "==> 7. Volume persistence across backend restart"
$COMPOSE restart dono-backend >/dev/null 2>&1
wait_for "${BASE}/api/health" 200 30 || fail "backend did not recover after restart"
stats="$(curl -s -H "Authorization: Bearer key_admin_${ADMIN_API_KEY}" "${BASE}/api/admin/stats")"
echo "    $stats"
echo "$stats" | grep -q '"donors":1' || fail "donor did not persist across restart: $stats"

echo "==> ALL SMOKE TESTS PASSED"
