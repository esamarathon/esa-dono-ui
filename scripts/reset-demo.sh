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
# Intended to be invoked by a host cron/systemd timer (daily/weekly) AND runnable
# on-demand before a big simulation run. See wayfinder #34.
#
# SAFETY: this runs `docker compose down -v`, which is destructive. It refuses to
# run unless DEMO_RESET_ALLOWED=1 is set, so it can never wipe a non-demo stack
# by accident.
#
# Usage:
#   DEMO_RESET_ALLOWED=1 ./scripts/reset-demo.sh [BASE] [CLIENT] [ADMIN_KEY]
#     BASE       backend base URL for seeding (default http://localhost:3001)
#     CLIENT     frontend base URL for magic links (default http://localhost:5173)
#     ADMIN_KEY  admin API key (default $ADMIN_API_KEY or "change-me")
set -euo pipefail

cd "$(dirname "$0")/.."

BASE=${1:-http://localhost:3001}
CLIENT=${2:-http://localhost:5173}
KEY=${3:-${ADMIN_API_KEY:-change-me}}
COMPOSE="docker compose"

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

# --- 3. Wait for backend health -------------------------------------------
echo -n "==> Waiting for backend health"
ready=""
for _ in $(seq 1 60); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  echo -n "."
  sleep 1
done
echo
if [ -z "$ready" ]; then
  echo "FAIL: backend never became healthy at $BASE/api/health" >&2
  $COMPOSE logs dono-backend 2>&1 | tail -40 >&2 || true
  exit 1
fi
echo "==> Backend healthy"

# --- 4. Re-seed deterministic baseline ------------------------------------
echo "==> Seeding demo baseline"
./seed-dev.sh "$BASE" "$CLIENT" "$KEY"

# --- 5. Completion marker (audit trail for scheduled runs) -----------------
echo "==> [$(ts)] Demo reset COMPLETE"
