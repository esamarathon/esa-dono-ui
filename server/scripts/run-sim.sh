#!/bin/sh
# run-sim.sh — wrapper that runs the seeded simulator inside the backend
# container with sane defaults, writing output to the persistent /data
# volume (survives container restarts; wiped only by a demo reset).
#
# Designed to be invoked directly (`docker exec ... server/scripts/run-sim.sh`)
# or on a schedule (see scripts/run-simulator.sh + the systemd timer on the
# host). Every run gets its own timestamped seed by default, so scheduled
# runs don't collide and each is independently reproducible.
#
# Env overrides (all optional):
#   SEED        seed string (default: sim-<UTC timestamp>)
#   EVENTS      event count (default: 150)
#   RATE        mean arrival rate (default: 3/s)
#   BASE_URL    API base (default: http://localhost:3001)
#   OUT_DIR     output dir (default: /data/sim-runs/<seed>)
#   KEEP_DAYS   prune sim-runs older than this many days (default: 14; 0 = never prune)
set -eu

SEED="${SEED:-sim-$(date -u +%Y%m%dT%H%M%SZ)}"
EVENTS="${EVENTS:-150}"
RATE="${RATE:-3/s}"
BASE_URL="${BASE_URL:-http://localhost:3001}"
OUT_DIR="${OUT_DIR:-/data/sim-runs/$SEED}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "run-sim.sh: ADMIN_API_KEY is not set in the container environment" >&2
  exit 1
fi

cd /app

echo "==> [$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting simulation run"
echo "    seed=$SEED events=$EVENTS rate=$RATE base_url=$BASE_URL out=$OUT_DIR"

node_modules/.bin/tsx server/scripts/simulate.ts \
  --seed "$SEED" \
  --events "$EVENTS" \
  --rate "$RATE" \
  --base-url "$BASE_URL" \
  --admin-key "$ADMIN_API_KEY" \
  --out "$OUT_DIR"
status=$?

echo "==> [$(date -u +%Y-%m-%dT%H:%M:%SZ)] Simulation run finished (exit $status)"

# Prune old run directories so /data doesn't grow unbounded on a recurring
# schedule. Skipped when KEEP_DAYS=0.
if [ "$KEEP_DAYS" != "0" ] && [ -d /data/sim-runs ]; then
  echo "==> Pruning sim-runs older than $KEEP_DAYS day(s)"
  find /data/sim-runs -maxdepth 1 -mindepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} \; 2>/dev/null || true
fi

exit $status
