#!/usr/bin/env bash
# Reset the demo site to a clean, deterministic baseline.
#
# Destroys the database volume, brings the stack back up (migrations run via the
# backend entrypoint), waits for health, then re-seeds via seed-dev.sh AND
# server/prisma/seed.ts (the latter recreates the persistent
# moderator@localhost/admin@localhost accounts and the API-key broadcast
# banner, which 'down -v' otherwise wipes every night — seed-dev.sh only
# covers demo rewards/polls/goals, not donor roles or the banner).
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
#     ADMIN_KEY  admin API key (default $ADMIN_API_KEY; required)
set -euo pipefail

cd "$(dirname "$0")/.."

BASE=${1:-http://localhost:3001}
CLIENT=${2:-http://localhost:5173}
KEY=${3:-${ADMIN_API_KEY:-}}
COMPOSE="docker compose"
SEED_HELPER_IMAGE="debian:12-slim" # has bash; curl+jq installed on the fly

# --- Safety fuse -----------------------------------------------------------
if [ "${DEMO_RESET_ALLOWED:-}" != "1" ]; then
  echo "REFUSING to reset: DEMO_RESET_ALLOWED is not set to 1." >&2
  echo "This script runs 'docker compose down -v' (destroys the DB volume)." >&2
  echo "Set DEMO_RESET_ALLOWED=1 only on the demo host." >&2
  exit 1
fi

# A manual invocation does not inherit systemd's EnvironmentFile. Never wipe
# the database and then discover that the seed used a guessed admin key.
if [ -z "$KEY" ]; then
  echo "REFUSING to reset: ADMIN_API_KEY (or the third argument) is required." >&2
  echo "For the configured staging environment, run: sudo systemctl start demo-reset.service" >&2
  exit 1
fi

# Validate the supplied credential against the running backend before teardown.
# Run inside it so this also works when no backend port is published to the host.
if [ -n "$($COMPOSE ps -q dono-backend)" ]; then
  echo "==> Checking admin authentication before reset"
  if ! ADMIN_API_KEY="$KEY" $COMPOSE exec -T -e ADMIN_API_KEY dono-backend node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:3001/api/admin/events", {
      headers: { Authorization: `Bearer key_admin_${process.env.ADMIN_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`Admin API preflight failed (HTTP ${response.status})`);
      process.exit(1);
    }
  '; then
    echo "REFUSING to reset: admin API authentication check failed; no data was deleted." >&2
    exit 1
  fi
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
  # One name per line: a backend on several networks must not produce one
  # concatenated name. Seed through the first network that reaches it. Skip
  # internal networks: the seed helper downloads curl and jq.
  NETWORKS=""
  for candidate in $(docker inspect "$BACKEND_CID" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}'); do
    if [ "$(docker network inspect --format '{{.Internal}}' "$candidate")" != true ]; then
      NETWORKS="$NETWORKS $candidate"
    fi
  done
  if [ -z "$NETWORKS" ]; then
    echo "FAIL: could not determine dono-backend's Docker network" >&2
    exit 1
  fi
  SEED_BASE="http://dono-backend:3001"
  echo -n "==> Waiting for backend health (via networks$NETWORKS, $SEED_BASE)"
  for _ in $(seq 1 30); do
    for candidate in $NETWORKS; do
      if docker run --rm --network "$candidate" curlimages/curl:8.10.1 -sf "$SEED_BASE/api/health" >/dev/null 2>&1; then
        NETWORK="$candidate"
        ready=1
        break 2
      fi
    done
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
  ADMIN_API_KEY="$KEY" ./seed-dev.sh "$BASE" "$CLIENT"
else
  # Direct path was unreachable — seed from a throwaway container on the
  # same Docker network as the backend, so seed-dev.sh's curl/jq calls reach
  # it via the service DNS name instead of a host port.
  # Secrets are passed by name only, never on a command line (visible in ps):
  # seed-dev.sh reads the admin key from ADMIN_API_KEY when no argument is given.
  ADMIN_API_KEY="$KEY" docker run --rm --network "$NETWORK" -v "$(pwd)/seed-dev.sh:/seed-dev.sh:ro" \
    -e ADMIN_API_KEY \
    -e SEED_RABBITMQ_URL -e SEED_RABBITMQ_EXCHANGE -e SEED_RABBITMQ_ROUTING_KEY -e SEED_RABBITMQ_DESCRIPTION \
    "$SEED_HELPER_IMAGE" \
    bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl jq >/dev/null 2>&1 && bash /seed-dev.sh '$SEED_BASE' '$CLIENT'"
fi

# --- 4b. Re-seed persistent moderator/admin accounts + key banner ---------
# seed-dev.sh (above) only seeds demo rewards/polls/goals over the HTTP API;
# it does not touch donor roles or the broadcast banner. Without this step,
# 'down -v' wipes the moderator@localhost/admin@localhost accounts and the
# API-key banner every night and they never come back until someone runs
# the seed by hand (server/prisma/seed.ts, run in-container since the
# runtime image ships no npm/npx).
echo "==> Seeding persistent dev accounts (moderator/admin) + key banner"
$COMPOSE exec -T -w /app/server dono-backend sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'

# --- 4c. Restore the demo baseline's feedback flag -------------------------
# The `feedback` flag migration inserts the row DISABLED (its fresh-install
# default). The demo baseline wants the feedback bubble on so testers can
# report; without this step the nightly reset silently turns the button off
# again. Goes through the same admin PATCH the admin UI uses, with the key
# the script already holds (passed by name to the API, never logged).
echo "==> Enabling the feedback feature flag"
if ! curl -sf -X PATCH "$SEED_BASE/api/admin/feature-flags/feedback" \
  -H "Authorization: Bearer key_admin_$KEY" \
  -H "Content-Type: application/json" \
  -d '{"is_enabled": true}' >/dev/null; then
  echo "WARN: could not enable the feedback feature flag" >&2
fi

# --- 4d. Restore the agent admin donor (agents read the queue via the REST API)
# The feedback-agent@localhost ADMIN donor is created out-of-band (by no seed),
# so 'down -v' would silently break the agents' REST access every night. The
# operator distributes its token to agents (and holds it in the service
# environment as DONO_FEEDBACK_AGENT_TOKEN); this step re-upserts the donor
# row with exactly that token. Without the variable, warn and skip rather
# than mint a token no agent can know.
if [ -n "$DONO_FEEDBACK_AGENT_TOKEN" ]; then
  echo "==> Restoring the feedback agent donor (feedback-agent@localhost)"
  if ! $COMPOSE exec -T -e DONO_FEEDBACK_AGENT_TOKEN -w /app/server dono-backend sh -c '
    node --input-type=module -e "
      import prisma from \"./lib/prisma.js\";
      const token = process.env.DONO_FEEDBACK_AGENT_TOKEN;
      await prisma.donor.upsert({
        where: { email: \"feedback-agent@localhost\" },
        update: { role: \"ADMIN\", email_verified: true, magic_token: token, is_frozen: false },
        create: { email: \"feedback-agent@localhost\", role: \"ADMIN\", email_verified: true, magic_token: token },
      });
      console.log(\"feedback agent donor restored\");
      await prisma.\$disconnect();
    "
  '; then
    echo "WARN: could not restore the feedback agent donor" >&2
  fi
else
  echo "WARN: DONO_FEEDBACK_AGENT_TOKEN unset; the feedback agent donor was NOT restored (agents' REST access stays broken)" >&2
fi

# --- 5. Completion marker (audit trail for scheduled runs) -----------------
echo "==> [$(ts)] Demo reset COMPLETE"
