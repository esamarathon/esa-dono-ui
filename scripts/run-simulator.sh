#!/usr/bin/env bash
# run-simulator.sh — host-side wrapper that runs the seeded simulator inside
# the running backend container (which already has Node + tsx + the
# simulator scripts copied in — see server/scripts/run-sim.sh).
#
# Intended to be invoked directly, or on a schedule via the
# simulator-run.timer systemd unit (see scripts/systemd/).
#
# Usage:
#   ./scripts/run-simulator.sh [CONTAINER]
#     CONTAINER  backend container name (default: esa-dono-ui-dono-backend-1,
#                or $SIM_CONTAINER)
#
# Env overrides forwarded into the container (all optional — see run-sim.sh
# for defaults): SEED, EVENTS, RATE, BASE_URL, OUT_DIR, KEEP_DAYS.
set -euo pipefail

CONTAINER="${1:-${SIM_CONTAINER:-esa-dono-ui-dono-backend-1}}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "run-simulator.sh: container '$CONTAINER' is not running" >&2
  exit 1
fi

# Forward only the env vars that are actually set, so run-sim.sh's own
# defaults apply otherwise.
env_args=()
for var in SEED EVENTS RATE BASE_URL OUT_DIR KEEP_DAYS; do
  if [ -n "${!var:-}" ]; then
    env_args+=("-e" "$var=${!var}")
  fi
done

exec docker exec "${env_args[@]}" "$CONTAINER" sh server/scripts/run-sim.sh
