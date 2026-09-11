# Simulating Donations / Recording a Real External Donation

Four methods for testing without real money, plus recording donations actually received outside Stripe (e.g. at an external event/platform — #62):

## Option A — Admin UI

Visit `/admin/simulate` (nav label "add donation"), fill in donor email + amount, click "Add Donation". Copy the generated magic link to access the donor wallet. To record a real donation received externally, also set an **external reference** (the source platform's own transaction id — used for dedup/traceability, must be unique) and a **date received** (backdates `Donation.created_at`; defaults to now).

## Option B — curl (direct webhook POST)

When `STRIPE_WEBHOOK_SECRET` is unset, HMAC verification is skipped:

```bash
curl -X POST http://localhost:3001/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"type":"checkout.session.completed","data":{"object":{"id":"cs_test_123","amount_total":1000,"customer_details":{"email":"test@example.com","name":"Test"}}}}'
```

## Option C — Admin API

```bash
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key_admin_change-me" \
  -d '{"email":"test@example.com","amount_cents":1000}'

# Recording a real donation received externally — external_id/occurred_at/
# channel_id are all optional. external_id must be unique (409 on reuse).
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key_admin_change-me" \
  -d '{"email":"test@example.com","amount_cents":2500,"external_id":"hekathon-12345","occurred_at":"2026-01-15T12:00:00.000Z"}'
```

Returns `{ success: true, token, donor }`. Build a magic link: `http://localhost:5173/api/auth/magic?token=<token>` (sets the session cookie, redirects to the wallet).

## Option D — Seeded platform simulator (bulk, reproducible)

For behavioral/bug-hunting runs against the resettable demo site — many donations and incentive selections in one go, replayable from a seed. See [wayfinder map #30](https://github.com/Codescales/esa-dono-ui/issues/30) for the design decisions.

```bash
# Inspect what a seed generates, offline, no server needed:
npx tsx server/scripts/simulate.ts --seed bug-repro-tuesday --events 50 --dry-run

# Run it for real against a local server:
ADMIN_API_KEY=change-me npx tsx server/scripts/simulate.ts \
  --seed bug-repro-tuesday --events 200 --rate 2/s

# Replay a prior run's exact decision log (flags any outcome divergence):
npx tsx server/scripts/simulate.ts --replay sim-runs/<runId>/decisions.jsonl
```

Key flags: `--seed` (int or string; the repro handle), `--events`/`--duration` (stopping condition), `--rate` (mean events/sec, e.g. `2/s`), `--base-url`, `--admin-key` (or `ADMIN_API_KEY` env), `--run-id` (donor-email isolation namespace, auto-generated if omitted), `--donors`, `--out` (default `./sim-runs/<runId>/`), `--dry-run`, `--verbose`.

Each run writes `decisions.jsonl` (the reproducible intent log), `outcomes.jsonl` (observed server responses, keyed by `seq`), and `manifest.json` (seed, simVersion, args, git SHA) under `--out`.

**Known limitation**: auction bids require a donor with a verified email, which no admin API can set — bids are attempted for coverage but expected to be rejected with 403 (logged as an expected note, not a failure).

To reset the demo to a clean baseline before/after simulation runs: `DEMO_RESET_ALLOWED=1 ./scripts/reset-demo.sh` (destroys and recreates the DB volume, then re-seeds via `seed-dev.sh`). Falls back to seeding via a throwaway container on the backend's own Docker network when the backend has no host port mapping (e.g. behind a reverse proxy with no published ports).

### Scheduled runs on a deployed host

For a container deployment where the backend has Node + `tsx` baked in (the standard runtime image does) but no host access, three pieces run the simulator on a recurring schedule:

- **`server/scripts/run-sim.sh`** — runs _inside_ the backend container. Sane defaults (`SEED` auto-generated from a UTC timestamp, `EVENTS=150`, `DONORS=45` — with the real-data donation amounts, enough distinct donors to fund the ~145 spend events per run so most succeed, `RATE=0.06/s` — spreads 150 events across ~42 min so an hourly run covers most of the hour, writes to `/data/sim-runs/<seed>` so output survives container restarts), all overridable via env vars, and prunes runs older than `KEEP_DAYS` (default 14).
- **`scripts/run-simulator.sh`** — host-side wrapper that `docker exec`s into the running backend container to invoke `run-sim.sh`, forwarding any of the env overrides that are set.
- **`scripts/reset-demo.sh`** — host-side nightly reset: `docker compose down -v` (drops the DB volume), brings the stack back up, waits for health, and re-seeds the deterministic baseline. Gated on `DEMO_RESET_ALLOWED=1` so it can never wipe a non-demo stack by accident.
- **`scripts/systemd/`** — three systemd units, all `Persistent=true`, installed/enabled by `install-systemd-timers.sh` (`sudo scripts/systemd/install-systemd-timers.sh`; idempotent and safe to re-run after editing unit files):
  - `simulator-run.{service,timer}` — runs the simulator **hourly 06:00–22:00 UTC** for all-day coverage.
  - `demo-reset.{service,timer}` — resets the demo **daily at 04:00 UTC**, after the last sim run of the previous day and before the first of the new one. `demo-reset.service` sets `DEMO_RESET_ALLOWED=1` and pulls `ADMIN_API_KEY` from `EnvironmentFile=` (the project `.env`); note the duplicate-key caveat below.

```bash
# Run once, right now:
./scripts/run-simulator.sh

# With overrides:
EVENTS=300 DONORS=40 RATE=0.1/s ./scripts/run-simulator.sh

# Install the recurring timers (simulator hourly 06-22 UTC + nightly 04:00 UTC reset):
sudo scripts/systemd/install-systemd-timers.sh
journalctl -u simulator-run.service -f   # tail sim logs
journalctl -u demo-reset.service -f      # tail reset logs
```

> **`.env` duplicate-key caveat (applies to `demo-reset.service`).** `reset-demo.sh` re-seeds through the admin API, so the `ADMIN_API_KEY` it uses must match the one the running backend was started with. The project `.env` currently lists `ADMIN_API_KEY` twice (a stale first value and a newer one); docker-compose applies the **last** occurrence, which is what the container sees. `demo-reset.service` reads the whole `.env` via `EnvironmentFile=`, where the **last** `ADMIN_API_KEY` also wins — so seeding and the live backend stay in agreement. If you ever edit the `.env`, keep only one `ADMIN_API_KEY` to avoid drift, or pin it explicitly with an `Environment=ADMIN_API_KEY=...` line in `demo-reset.service`.
>
> If the backend has **no host port mapping** (e.g. the oci-public demo behind Caddy on a shared proxy network), `reset-demo.sh` falls back to health-checking and seeding from a throwaway `curlimages/curl` container on the backend's own Docker network, addressing it by its compose service DNS name (`dono-backend`). It only needs host docker/compose access — which the service's `ubuntu` user has via the `docker` group.
