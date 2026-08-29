# Simulating Donations

Three methods for testing without real money:

## Option A — Admin UI

Visit `/admin/simulate`, fill in donor email + amount, click "Simulate Donation". Copy the generated magic link to access the donor wallet.

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

- **`server/scripts/run-sim.sh`** — runs _inside_ the backend container. Sane defaults (`SEED` auto-generated from a UTC timestamp, `EVENTS=150`, `RATE=3/s`, writes to `/data/sim-runs/<seed>` so output survives container restarts), all overridable via env vars, and prunes runs older than `KEEP_DAYS` (default 14).
- **`scripts/run-simulator.sh`** — host-side wrapper that `docker exec`s into the running backend container to invoke `run-sim.sh`, forwarding any of the env overrides that are set.
- **`scripts/systemd/`** — `simulator-run.service` + `simulator-run.timer` (every 6h by default, `Persistent=true`) and `install-systemd-timers.sh` to install/enable them (`sudo scripts/systemd/install-systemd-timers.sh`).

```bash
# Run once, right now:
./scripts/run-simulator.sh

# With overrides:
EVENTS=300 RATE=5/s ./scripts/run-simulator.sh

# Install the recurring timer:
sudo scripts/systemd/install-systemd-timers.sh
journalctl -u simulator-run.service -f   # tail logs
```
