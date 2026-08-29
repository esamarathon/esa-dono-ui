#!/usr/bin/env bash
# Reset the demo site to a clean, deterministic baseline.
#
# Destroys the database volume, brings the stack back up (migrations run via the
# backend entrypoint), waits for health, then re-seeds via seed-dev.sh.
#
# This is engine-agnostic: `down -v` drops whichever data volume backs the DB
# (SQLite file today, a Postgres pgdata volume in future), and seed-dev.sh seeds
# through the HTTP API rather than the DB directly.
#
# Network topology: some deployments publish backend/frontend ports to the host
# (this repo's own docker-compose.yml does); others front everything through a
# shared reverse-proxy network with no host port mapping at all (e.g. the
# oci-public demo, which sits behind Caddy on a Docker network it doesn't
# publish). This script tries the direct BASE URL first, and if the backend
# never becomes reachable that way, falls back to running health checks and
# seeding from a throwaway container attached to the backend's own Docker
# network, addressing it by its compose service DNS name (dono-backend) rather
# than a host port.
#
# Intended to be invoked by a host cron/systemd timer (daily/weekly) AND runnable
# on-demand before a big simulation run. See wayfinder #34.
#
# SAFETY: this runs `docker compose down -v`, which is destructive. It refuses to
# run unless DEMO_RESET_ALLOWED=1 is set, so it can never wipe a non-demo stack
# by accident.
#
# Usage:
#   DEMO_RESET_ALLOWED=1 ./scripts/reset-demo.sh [BASE] [CLIENT] [ADMIN_KEY]
#     BASE       backend base URL for the direct/host-port path
#                (default http://localhost:3001)
#     CLIENT     frontend base URL for magic links
#                (default http://localhost:5173, only used in echoed output)
#     ADMIN_KEY  admin API key (default $ADMIN_API_KEY or "change-me")
set -euo pipefail

cd "$(dirname "$0")/.."

BASE=${1:-http://localhost:3001}
CLIENT=${2:-http://localhost:5173}
KEY=${3:-${ADMIN_API_KEY:-change-me}}
COMPOSE="docker compose"
SEED_HELPER_IMAGE="debian:12-slim" # has bash; curl+jq installed on the fly

# --- Safety fuse -----------------------------------------------------------
if [ "${DEMO_RESET_ALLOWED:-}" != "1" ]; then
  echo "REFUSING to reset: DEMO_RESET_ALLOWED is not set to 1." >&2
  echo "This script runs 'docker compose down -v' (destroys the DB volume)." >&2
  echo "Set DEMO_RESET_ALLOWED=1 only on the demo host." >&2
  exit 1
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "==> [$(ts)] Demo reset starting (BASE=$BASE)"

# --- 1. Tear down + drop volume -------------------------------------------
echo "==> Tearing down stack and dropping data volume"
$COMPOSE down -v

# --- 2. Bring back up (entrypoint runs prisma migrate deploy) --------------
echo "==> Starting stack"
$COMPOSE up -d

# --- 3. Wait for backend health --------------------------------------------
# Try the direct host URL first (fast path for deployments that publish
# ports). If it never comes up, fall back to the internal Docker network.
echo -n "==> Waiting for backend health (direct: $BASE)"
ready=""
for _ in $(seq 1 30); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  echo -n "."
  sleep 1
done
echo

SEED_BASE="$BASE"
if [ -z "$ready" ]; then
  echo "==> Direct URL unreachable; falling back to the internal Docker network"
  BACKEND_CID=$($COMPOSE ps -q dono-backend)
  if [ -z "$BACKEND_CID" ]; then
    echo "FAIL: could not find the dono-backend container" >&2
    exit 1
  fi
  NETWORK=$(docker inspect "$BACKEND_CID" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' | awk '{print $1}')
  if [ -z "$NETWORK" ]; then
    echo "FAIL: could not determine dono-backend's Docker network" >&2
    exit 1
  fi
  SEED_BASE="http://dono-backend:3001"
  echo -n "==> Waiting for backend health (via network $NETWORK, $SEED_BASE)"
  for _ in $(seq 1 30); do
    if docker run --rm --network "$NETWORK" curlimages/curl:8.10.1 -sf "$SEED_BASE/api/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    echo -n "."
    sleep 1
  done
  echo
fi

if [ -z "$ready" ]; then
  echo "FAIL: backend never became healthy (direct: $BASE, network fallback also failed)" >&2
  $COMPOSE logs dono-backend 2>&1 | tail -40 >&2 || true
  exit 1
fi
echo "==> Backend healthy"

# --- 4. Re-seed deterministic baseline ------------------------------------
echo "==> Seeding demo baseline"
if [ "$SEED_BASE" = "$BASE" ]; then
  ./seed-dev.sh "$BASE" "$CLIENT" "$KEY"
else
  # Direct path was unreachable — seed from a throwaway container on the
  # same Docker network as the backend, so seed-dev.sh's curl/jq calls reach
  # it via the service DNS name instead of a host port.
  docker run --rm --network "$NETWORK" -v "$(pwd)/seed-dev.sh:/seed-dev.sh:ro" "$SEED_HELPER_IMAGE" \
    bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl jq >/dev/null 2>&1 && bash /seed-dev.sh '$SEED_BASE' '$CLIENT' '$KEY'"
fi

# --- 5. Completion marker (audit trail for scheduled runs) -----------------
echo "==> [$(ts)] Demo reset COMPLETE"
