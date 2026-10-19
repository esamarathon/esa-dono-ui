# Deployment Guide

How to run **esa-dono-ui** in development and production. This document is the
authoritative reference for both humans and AI agents operating the stack. It
describes the current (Stripe) payments integration — the `TILTIFY_*` variables
that appear in an older `README.md` are **deprecated** (see ADR 0002).

## Architecture at a glance

```
npm workspaces monorepo
├── client/           React 18 + Vite + Tailwind SPA
├── server/           Express 4 API (ESM, run via tsx) + Prisma + SQLite
└── packages/shared/  @dono/shared — cross-cutting types (money, pledge data)
```

- **Payments**: Stripe Checkout (`checkout.session.completed` webhook).
- **Auth**: magic-link email tokens + OAuth (Google / Discord / Twitch). No
  passwords. Donors are identified by email.
- **Data**: SQLite or PostgreSQL via Prisma, selected by `DATABASE_URL`. SQLite uses a single file. All money is integer cents.
- **Production** ships two images: `backend` (Express, non-root `dono`, UID 1001) and `frontend` (nginx-unprivileged SPA, proxies `/api/` → backend).

```
Donor/Browser → [external proxy: Caddy/nginx/LB, optional] → nginx (frontend :8080) ──/api/*──→ backend (Express :3001) → SQLite (/data/dono.db)
Stripe webhook → backend /api/webhooks/stripe (raw body, before express.json)
```

Every proxy in front of the backend is one **hop**. `TRUST_PROXY` must equal the
number of hops, or rate limiting cannot see the visitor's IP (see
[§ Client IP and `TRUST_PROXY`](#client-ip-and-trust_proxy)).

---

## Prerequisites

| Tool    | Version         |
| ------- | --------------- |
| Node.js | 22+             |
| npm     | 10+             |
| Docker  | 20+ (or Podman) |

---

## Development (local)

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. For local dev the only truly required value to get a running
stack is `ADMIN_API_KEY` (used to log into `/admin` and `/moderate`). Leaving
Stripe/SMTP/OAuth unset degrades gracefully (see table below).

### 3. Initialize the database

```bash
npm run db:generate --workspace server
npm run db:migrate --workspace server
```

### 4. Run

```bash
npm run dev
```

- Server: `http://localhost:3001` (health at `/api/health`)
- Client: `http://localhost:5173` (Vite proxies `/api` → `:3001`)

### 5. Seed demo data (optional)

```bash
BASE=http://localhost:3001 ./seed-dev.sh
```

`seed-dev.sh` creates two Channels (`main-marathon`, `bonus-stream`), incentives,
donations, claims, votes and contributions over the admin and donor APIs
(bearer auth). Set `SEED_RABBITMQ_URL` (and optionally `SEED_RABBITMQ_EXCHANGE`,
`SEED_RABBITMQ_ROUTING_KEY`, `SEED_RABBITMQ_DESCRIPTION`) to also create a
RabbitMQ Destination before the donations, so they are published. The script
does not print secrets: the admin key is masked, the AMQP URL is never
shown, and the demo wallet magic links appear only on an interactive terminal.

### 6. Tests / typecheck / lint

```bash
npm test                          # all workspaces (via per-workspace vitest configs)
npm run test --workspace server   # server only
npm run test --workspace client   # client only
npm run test:ci                   # CI mode (junit reporter)
npm run typecheck                 # tsc --noEmit, all workspaces
npm run lint
```

> **Agent note:** run tests through the npm scripts above, **not** `npx vitest`
> from the repo root — the root-level vitest config uses the wrong environment
> and will fail.

---

## Production (Docker)

### 1. Build the images

```bash
docker build -f Dockerfile.backend --target runtime -t ghcr.io/esamarathon/esa-dono-ui/backend:latest .
docker build -f Dockerfile.frontend             -t ghcr.io/esamarathon/esa-dono-ui/frontend:latest .
```

Or pull the CI-published multiarch images (amd64/arm64). Every push to `main`
or `dev` publishes images tagged with the sanitized branch name and the commit
sha; `main` additionally gets `latest`. PRs against `main` publish `pr-<number>`
(not scanned/smoke-tested further). `docker-compose.yml` defaults to `:latest`
for both images; override with `BACKEND_IMAGE_TAG`/`FRONTEND_IMAGE_TAG` to run
a specific branch or commit build instead:

```bash
docker pull ghcr.io/esamarathon/esa-dono-ui/backend:latest
docker pull ghcr.io/esamarathon/esa-dono-ui/frontend:latest

# or a specific branch/commit build:
docker pull ghcr.io/esamarathon/esa-dono-ui/backend:dev
BACKEND_IMAGE_TAG=dev FRONTEND_IMAGE_TAG=dev docker compose up -d
```

### 2. Configure environment

`docker-compose.yml` reads its values from the host environment / `--env-file`.
`ADMIN_API_KEY` is **mandatory** (compose fails fast if unset).

```bash
cp .env.example .env.production
```

At minimum set:

```bash
ADMIN_API_KEY=…                  # required — compose uses ${ADMIN_API_KEY:?...}
APP_BASE_URL=https://donations.example.com
STRIPE_SECRET_KEY=sk_live_…      # optional — omitted → checkout degrades gracefully
STRIPE_WEBHOOK_SECRET=whsec_…    # optional — omitted → webhook sig check skipped
SMTP_HOST=…                      # optional — omitted → magic links logged to stdout
TRUST_PROXY=2                    # REQUIRED behind an external proxy (TLS terminator, load
                                 # balancer); 1 (default) only when browsers reach the
                                 # frontend container directly. See § Client IP.
```

### 3. Start

```bash
docker compose --env-file .env.production up -d --build
# or, with images already built/pulled:
docker compose --env-file .env.production up -d
```

- Frontend: `http://localhost:8080` (port via `FRONTEND_PORT`, default 8080).
- SQLite persists in the named volume `dono-data` (mounted at `/data`). PostgreSQL
  uses the service named in `DATABASE_URL`; uploaded images still need the volume.
- The entrypoint selects and deploys the provider's migrations on every startup.
  The same image supports both providers; changing the URL does not transfer data.
  See [Database Management](database.md).

### 4. Verify

```bash
curl -s http://localhost:8080/api/health        # → {"ok":true,"db":true}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/rewards   # → 200 (SPA fallback)
```

Behind an external proxy, also check that each visitor gets their own rate-limit
counter (run from two different networks, e.g. your machine and the server):

```bash
curl -sI https://donations.example.com/api/campaign | grep -i x-ratelimit-remaining
```

Each network should count down from `RATE_LIMIT_API` (default 600) on its own.
If a second network continues the first one's count, `TRUST_PROXY` is too low.

Disposable local end-to-end validation only (writes donations and tears the stack down
on exit). **Never run this against a deployment or its volumes:**

```bash
ADMIN_API_KEY=… FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

### 5. External reverse proxy

A public production deployment normally puts a TLS terminator (Caddy, nginx, a
cloud load balancer) in front of the frontend container. **Then set
`TRUST_PROXY=2`** (see [§ Client IP and `TRUST_PROXY`](#client-ip-and-trust_proxy)).

Point TLS at the frontend container (`:8080`) and let it proxy `/api/`:

```nginx
server {
  listen 443 ssl;
  server_name donations.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Caddy: `reverse_proxy /* 127.0.0.1:8080`

> The frontend container already forwards `/api/*` to `dono-backend:3001`, so
> an external proxy only needs to reach the frontend.

#### Client IP and `TRUST_PROXY`

The rate limits are per client IP: `RATE_LIMIT_API` on the whole API, plus the
stricter auth, feedback and metrics limits (the spend limit is per donor, but
falls back to the IP for anonymous requests). The backend reads the client
IP from `X-Forwarded-For`, counting `TRUST_PROXY` proxies back from itself.

| Setup                                                               | `TRUST_PROXY` |
| ------------------------------------------------------------------- | ------------- |
| Browsers reach the frontend container directly (no proxy before it) | `1` (default) |
| One external proxy (Caddy, nginx, a load balancer) → frontend       | `2`           |
| Two external proxies (e.g. CDN → load balancer → frontend)          | `3`           |

- **Too low:** every visitor gets the proxy's address and **all share one
  bucket**. Six magic-link requests from different people in one minute then
  block everyone (#140).
- **Too high:** a client can choose its own IP with a forged `X-Forwarded-For`
  and escape the limits.
- Each external proxy must **append** to `X-Forwarded-For`. Caddy does by
  default; the nginx example above sets it; check your load balancer.
- Check after every proxy change: [§ 4. Verify](#4-verify).

##### Internal consumers: `RATE_LIMIT_EXEMPT_IPS`

kollekt polls the Tiltify-compatible API about 36 times/min per Channel, and the
overlay polls it too. With many Channels this exceeds `RATE_LIMIT_API`.
`RATE_LIMIT_EXEMPT_IPS` lists IPs and CIDRs (comma-separated, IPv4 or IPv6;
`::ffff:172.18.0.5` matches `172.18.0.5`) whose requests skip `RATE_LIMIT_API`.
The auth, spend, feedback and metrics limits still apply. An invalid entry stops
the backend at startup. Empty (the default) exempts nobody.

The match is against the resolved client IP, the same one the limits use:

- A consumer that connects **directly** to `dono-backend:3001` has its container
  address as the client IP (it sends no `X-Forwarded-For`).
- A request through the frontend nginx gets its client IP from `X-Forwarded-For`,
  `TRUST_PROXY` hops back. A client cannot choose that address unless
  `TRUST_PROXY` is too high, so the proxy chain must be correct first.

List only addresses the public cannot present: consumer containers on the private
Docker network that reach the backend directly. **Never list the address of a
proxy** (the frontend nginx, Caddy, or the Docker gateway that Caddy on the host
appears as). If `TRUST_PROXY` is too low, every public request has that proxy
address, and all public traffic is exempt. A whole network CIDR includes those
addresses, so prefer the consumer containers' own IPs. Find them with:

```bash
docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{$c.IPAddress}}{{"\n"}}{{end}}' <container>
```

A container can get a new address when it is recreated. Pin it with
`ipv4_address` in its Compose service, or put the consumers on a dedicated
network with the backend and list that network's subnet
(`docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' <network>`).

---

## Configuration reference

| Variable                            | Required       | Default                                                    | Purpose                                                            |
| ----------------------------------- | -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `ADMIN_API_KEY`                     | **yes (prod)** | —                                                          | `Bearer key_admin_<key>` for `/api/admin/*`                        |
| `MODERATOR_API_KEY`                 | no             | —                                                          | `Bearer key_mod_<key>` operational fallback for `/api/moderator/*` |
| `ADMIN_EMAILS`                      | no             | —                                                          | comma-separated emails granted ADMIN role at request time          |
| `MODERATOR_EMAILS`                  | no             | —                                                          | comma-separated emails granted MODERATOR role at request time      |
| `STRIPE_SECRET_KEY`                 | no             | —                                                          | enable Stripe Checkout (absent → degrade gracefully)               |
| `STRIPE_WEBHOOK_SECRET`             | no             | —                                                          | verify webhook signatures (absent → skip)                          |
| `STRIPE_CURRENCY`                   | no             | `usd`                                                      | checkout currency                                                  |
| `STRIPE_SHIPPING_RATE_ID`           | no             | —                                                          | ShippingRate for PHYSICAL rewards                                  |
| `STRIPE_SHIPPING_ALLOWED_COUNTRIES` | no             | `US`                                                       | countries for shipping collection                                  |
| `CAMPAIGN_GOAL_CENTS`               | no             | `500000`                                                   | home-page goal (integer cents)                                     |
| `GOOGLE_CLIENT_ID/SECRET`           | no             | —                                                          | Google SSO (unset → disabled)                                      |
| `DISCORD_CLIENT_ID/SECRET`          | no             | —                                                          | Discord SSO (unset → disabled)                                     |
| `TWITCH_CLIENT_ID/SECRET`           | no             | —                                                          | Twitch SSO (unset → disabled)                                      |
| `SMTP_HOST/PORT/SECURE/USER/PASS`   | no             | `587`/`false`                                              | magic-link email (unset host → log links to stdout)                |
| `EMAIL_FROM`                        | no             | `Donation Platform <no-reply@example.com>`                 | sender address                                                     |
| `METRICS_API_KEY`                   | no             | —                                                          | `Bearer key_metrics_<key>` for `/api/metrics` (unset → 404)        |
| `METRICS_REFRESH_MS`                | no             | `45000`                                                    | business-metrics cache refresh interval                            |
| `APP_BASE_URL`                      | no             | dev `http://localhost:5173` / prod `http://localhost:8080` | magic-link + Stripe redirect base                                  |
| `PORT`                              | no             | `3001`                                                     | server listen port                                                 |
| `DATABASE_URL`                      | no             | dev `file:./dev.db` / prod `file:/data/dono.db`            | Prisma URL                                                         |
| `UPLOADS_DIR`                       | no             | prod `/data/uploads` / dev `server/uploads`                | reward image storage                                               |
| `RATE_LIMIT_SPEND`                  | no             | `20`                                                       | spend endpoints req/min/donor                                      |
| `RATE_LIMIT_AUTH`                   | no             | `5`                                                        | auth endpoints req/min/IP                                          |
| `RATE_LIMIT_METRICS`                | no             | `30`                                                       | `/api/metrics` req/min/IP                                          |
| `RATE_LIMIT_API`                    | no             | `600`                                                      | all of `/api/*` req/min/IP (#140)                                  |
| `RATE_LIMIT_EXEMPT_IPS`             | no             | —                                                          | IPs/CIDRs that skip `RATE_LIMIT_API` (internal pollers only)       |
| `TRUST_PROXY`                       | no             | `1`                                                        | proxy hops in front of Express (#140)                              |

OAuth redirect URIs to register with each provider:
`${APP_BASE_URL}/api/auth/{google,discord,twitch}/callback`.

---

## Operations

### Logs / status / restart

```bash
docker compose logs -f dono-backend dono-frontend
docker compose ps
docker compose restart dono-backend
```

### Backup / restore (SQLite)

The DB is a single file at `/data/dono.db` in the backend container. Prefer an
online atomic backup:

```bash
docker compose exec dono-backend sh -c 'sqlite3 /data/dono.db ".backup /data/dono-backup.db"'
docker compose cp dono-backend:/data/dono-backup.db ./dono-backup-$(date +%Y%m%d).db
```

Offline copy (stop writes first):

```bash
docker compose stop dono-backend
docker compose cp dono-backend:/data/dono.db ./dono-backup.db
docker compose start dono-backend
```

Restore requires the [no-new-writes guard](#rollback-without-erasing-writes) below.
A timestamp or a zero creation count alone is not permission to restore.

### Seeding data (development / staging)

To create persistent dev accounts (moderator@localhost, admin@localhost) and a
banner displaying API keys, run the seed script.

The production runtime image has no npm/npx (stripped to keep the image slim),
so invoke `tsx` directly against `node_modules/.bin` rather than
`npx prisma db seed` (its seed runner shells out to plain `tsx` via `$PATH`,
which isn't set up in an `exec` session):

```bash
docker exec -w /app/server <backend-container-name> sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'
```

(In local development, where npm is available, `cd server && npx prisma db seed` works directly — see `docs/local-development.md`.)

This creates:

- Moderator account (role: MODERATOR, email_verified: true)
- Admin account (role: ADMIN, email_verified: true)
- Broadcast banner showing current MODERATOR_API_KEY and ADMIN_API_KEY from .env
- One **active Event** with an active **primary Channel**. The seed reuses the first Event (the migration creates `default-event`) and its earliest active Channel, or creates "Main Channel". This is why donations route without any setup (ADR-0008)

The seed is idempotent — running it multiple times updates existing records
safely. Accounts and banner survive database restarts, including staging's daily
reset cycle. See `docs/STAGING_SEED.md` for detailed staging instructions.

### Migrations

Handled automatically by the backend entrypoint, which selects the migration
history from `DATABASE_URL`. From the source checkout, use:

```bash
npm run db:generate --workspace server
npm run db:migrate --workspace server
```

Model changes need new migrations in both provider histories. The canonical model
schema stays SQLite; generation derives the PostgreSQL schema. Preserve the custom
checks, partial indexes and triggers on both providers. See [Database Management](database.md).

**Migrations that need a reset.** `20260928211407_event_channel_identity` (#114)
switches ids to UUIDs and adds Event, slugs and a primary Channel. It applies to an
existing database: existing Channels are attached to a default Event and get
`channel-<id>` slugs. But only new rows get UUIDs. Reset dev and staging so that
every id is a UUID:

- **Local:** `cd server && npx prisma migrate reset`. This drops the database,
  reapplies every migration and runs the seed.
- **Staging:** `scripts/reset-demo.sh`. This drops the volume, migrates, runs
  `seed-dev.sh`, then `prisma/seed.ts`.

**Shared incentive owner (ADR-0012).** `20261017000000_shared_incentive_event` gives
every reward, poll, goal and auction an `event_id`: the Event of its Channel; for a
shared incentive the only Event, else the one Event in which it has allocations
(donations or Pool credit batches). If any shared incentive has no single Event, the
migration fails, changes nothing and records a failed migration. Find those rows
before deploying, on a backup copy:

```sql
-- Shared incentives; with two or more Events, each needs allocations in exactly one.
SELECT 'Reward' AS kind, id, title FROM Reward WHERE channel_id IS NULL
UNION ALL SELECT 'Poll', id, title FROM Poll WHERE channel_id IS NULL
UNION ALL SELECT 'FundGoal', id, title FROM FundGoal WHERE channel_id IS NULL
UNION ALL SELECT 'Auction', id, title FROM Auction WHERE channel_id IS NULL;
```

Give each unresolved one a Channel, or split it into one copy per Event. Then mark the
failed attempt with `npx prisma migrate resolve --rolled-back
20261017000000_shared_incentive_event` and deploy again. The migration also adds
SQLite triggers that keep a Channel incentive in its Channel's Event; a later table
rebuild of these tables must recreate them.

### Rollback

Redeploy a previous image tag (CI also tags `backend:<sha>` /
`frontend:<sha>`, plus `backend:<branch>` / `frontend:<branch>` per pushed
branch, e.g. `:main`, `:dev`):

```bash
docker compose pull && docker compose up -d
# or pin a specific build:
docker tag ghcr.io/esamarathon/esa-dono-ui/backend:<sha> ghcr.io/esamarathon/esa-dono-ui/backend:latest
```

DB migrations are append-only. A previous image must not open an incompatible new
schema. Follow the guard below before considering a backup restore; otherwise fix forward.

### Amount-first transition: one release between Events

This is an operator procedure, **not authorization to deploy**. Rehearse on a disposable
copy first. Ship the complete pooled release, not individual slices. Cold/warm cross-Channel
Kollekt hydration requires the coordinated PR44 fix and scoped ESA lookup described in
`docs/api-consumers.md`; ordinary own/shared lists stay unchanged. Until the actual pinned
runtime report and final release review pass, release acceptance is **PENDING**. Do not
prewarm caches, widen producer lists, reassign donations or drop assertions to clear a HOLD.

Tools: `server/scripts/transition-cli.ts --help` (run with `node --import tsx` from
the release root). They never load `.env` or default to `DATABASE_URL`. Every operation
requires an existing absolute `file:` URL and a **new** absolute report path (0600;
never overwrite evidence). `--apply` is opt-in. Keep reports in a private operator directory.
For container execution use `/app/node_modules/.bin/tsx`; do not use npm/npx in the
runtime image. Run tools in a one-off container with its entrypoint overridden, only the
explicit DB/report mounts, and no backend process, rather than inheriting live startup.

1. With separate human deployment authorization, inspect the Stripe webhook endpoint's
   **actual API version** and the installed Stripe SDK (`npm ls stripe` in the build
   checkout; the tested SDK was 22.5.0, default API `2026-07-29.dahlia`). Review versioned
   Checkout/Refund notification shapes. In the dashboard subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, and `refund.*`
   (including created, updated, failed). Preserve auction subscriptions. Do not change
   dashboard versions/subscriptions or use real keys during rehearsal.
2. Confirm **no Event is active**. Deactivate the Event first, then every Channel
   (`PUT /api/admin/events/:id`, `PUT /api/admin/channels/:id`, `is_active:false`). Do
   not End an Event as a substitute: End changes credit eligibility. Check both lists.
   Inactive Channels stop new pledges (404), but are NOT a complete write freeze.
3. Establish an external write freeze: block all public/staff mutations, pause external
   callers/simulators, worker/consumer administrative writes and schedulers; restrict
   database access. During the drain retain the old backend's signed Stripe receipt path
   so already paid money is recorded. Inventory unresolved/processing Sessions; their
   receipts may arrive after cutover. Never treat a local deadline as non-payment.
4. From the new tooling checkout, against the explicit **old-schema** DB, run the drain.
   It reads only old OPEN pledges, expires only provider-open/unpaid Sessions on apply,
   then retrieves again even after an expire error. It never marks local pledges terminal,
   releases funding, records payment or guesses missing/unbound Sessions. `PAID`,
   `COMPLETE_UNPAID`, `STILL_OPEN`, `UNKNOWN` require review; complete/unpaid can settle
   later. Missing Sessions/lost creates stay unknown. Review every page and rerun from
   the start to verify the final provider state before stopping the old backend.

   ```bash
   # Set DB, REPORTS and CUTOVER explicitly to the rehearsal paths / chosen UTC instant.
   # KEY_FILE is an explicit private Stripe key file; never an environment fallback.
   node --import tsx server/scripts/transition-cli.ts drain --database-url "$DB" \
     --before "$CUTOVER" --limit 100 --stripe-key-file "$KEY_FILE" --report "$REPORTS/drain-dry.json"
   # Only after reviewing dry run; use --after <next_after> for each further page.
   node --import tsx server/scripts/transition-cli.ts drain --database-url "$DB" \
     --before "$CUTOVER" --limit 100 --stripe-key-file "$KEY_FILE" --apply --report "$REPORTS/drain-applied.json"
   ```

   In rehearsal replace `--stripe-key-file` with `--stripe-fixture /absolute/sessions.json`.
   Fixture format: an object keyed by Session id, each value containing `id`, `status`,
   `payment_status`, `amount_total`, `total_details:{amount_shipping}`. No network is used.

5. Stop the backend and all remaining writers (including outbox dispatch), complete the
   freeze, then take a consistent SQLite backup. This stop requires human authorization.
   Record UTC `BACKUP_AT`, release/image hashes, schema migrations, freeze owner and all
   outstanding provider facts. Use host `sqlite3` or a separate approved SQLite utility;
   it is **not installed in the runtime image**. With the backend stopped, an example on
   the explicitly mounted DB is:

   ```bash
   BACKUP_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"
   sqlite3 -readonly "$BACKUP_FILE" 'PRAGMA integrity_check;'
   node --import tsx server/scripts/transition-cli.ts report --database-url "$BACKUP_DB" \
     --report "$REPORTS/pre-migration.json"
   ```

   Keep the backup immutable and private. Do not copy a running WAL database's main file
   alone. Preserve uploads/config separately. A queued Stripe retry after cutover is a
   **new write** and ends restore eligibility.

6. Deploy **one pinned release** and apply its append-only migrations/backfills once.
   The normal entrypoint runs `prisma migrate deploy`; do not seed/reset or run dev
   migrations. Under the freeze, use the entrypoint's migration command with the backend
   still stopped if a rollback checkpoint is required. Rehearse all migrations against a
   populated backup. #184 zeros only historical `wallet-<uuid>` amounts (literal lowercase
   prefix, exact 8-4-4-4-12 hexadecimal UUID, either hex case) and expires old OPEN pledges.
   Other `wallet-` references are cash, not proof of Wallet funding. The pooled migration
   is unshipped; if it has already run outside disposable tests, stop for review rather
   than editing deployed history or guessing erased amounts. Terminal statuses, Wallet
   balances and NULL pledge amounts remain historical. #194 does not repeat this backfill.
7. Before starting writers, capture a final-schema checkpoint with `checkpoint
--database-url "$DB" --backup-at "$BACKUP_AT" --report "$REPORTS/checkpoint.json"`.
   Review the migration-only delta from the backup (prefer a separately migrated backup
   as the expected state). Migration timestamps, including old OPEN expiry dates and
   `_prisma_migrations.finished_at`, can be after the backup; they need explicit review,
   not silent exclusion. If any application write occurred before this checkpoint, or
   you cannot prove the freeze, **FIX FORWARD**. Then start the new backend with external
   writes still blocked and perform only read-only health/report checks. Starting outbox
   dispatch can update deliveries, so it can itself end restore eligibility.
8. Run `GET /api/health`, `server/scripts/pooled-migration-report.ts --database-url "$DB"`,
   and `transition-cli.ts report --database-url "$DB" --report "$REPORTS/post-migration.json"`.
   Reconcile: **old counted money − counted old wallet amounts = post-migration counted
   money**; after shipping, subtract only successfully corrected counted shipping.
   Counted means COMPLETED + REFUNDED, never incentive allocations. Separately compare
   each Donor's `total_donated` with report `received_cents`: the sum of current Donation
   amounts across ALL statuses, excluding only exact `wallet-<uuid>` rows. This cumulative
   receipt history is not `counted_cents`; a difference from counted money is not itself
   a donor-total error. A mismatch with receipt history requires manual review, not
   overwriting balances/totals. #184 does not rewrite historical donor totals. Preserve
   legacy REFUNDED/CHARGEBACK status, refund links, adjustments and allocations; never
   automatically repair old reversals (#163). Verified fee extraction below is a separate
   correction, not reversal repair. No donation-writing smoke/seed/reset command is
   permitted against a deployment.
9. **Overlay binding check before any replay:** verify Event/Channel ids AND slugs,
   Destination exchange/routing keys and each overlay/reader binding, with the operator
   off air or explicitly accepting replay. Check consumers' active image/source revisions.
   Shipping dry-run/apply is separate from publication:

   ```bash
   node --import tsx server/scripts/transition-cli.ts shipping --database-url "$DB" \
     --before "$CUTOVER" --limit 100 --stripe-key-file "$KEY_FILE" --report "$REPORTS/shipping-dry.json"
   node --import tsx server/scripts/transition-cli.ts shipping --database-url "$DB" \
     --before "$CUTOVER" --limit 100 --stripe-key-file "$KEY_FILE" --apply --report "$REPORTS/shipping-applied.json"
   node --import tsx server/scripts/transition-cli.ts publish --database-url "$DB" \
     --corrections "$REPORTS/shipping-applied.json" --wallet-baseline "$REPORTS/pre-migration.json" \
     --report "$REPORTS/publication-dry.json"
   node --import tsx server/scripts/transition-cli.ts publish --database-url "$DB" \
     --corrections "$REPORTS/shipping-applied.json" --wallet-baseline "$REPORTS/pre-migration.json" \
     --apply --overlay-binding-ack --report "$REPORTS/publication-applied.json"
   ```

   Paginate shipping to exhaustion; pass each applied report with repeatable
   `--corrections`. A publication accepts at most 1000 input corrections; if more are
   needed stop for a reviewed publication plan (separate batches repeat scoped totals).
   Shipping requires the exact complete/paid Session, gross matching the current amount
   and an integer nonnegative shipping amount. All four known legacy statuses (COMPLETED,
   PENDING, REFUNDED, CHARGEBACK) are eligible without changing status or refund links.
   Every verified fee lowers `amount_cents` AND cumulative `total_donated`; only fees on
   COMPLETED/REFUNDED lower counted money. Before any positive fee, donor `total_donated`
   must exactly equal the known `received_cents` history and cover the fee. Otherwise both
   dry-run and apply report `DONOR_TOTAL_MANUAL_REVIEW` and change nothing. Already-recorded
   shipping (even zero) is never subtracted again. Unknown/changed/already-net facts,
   unknown statuses and pooled-with-missing-shipping records require review, never guesses.
   Wallet balances, stock, old adjustments and all allocations are untouched. This follows
   [#173 §5](https://github.com/esamarathon/esa-dono-ui/issues/173#issuecomment-6116662382)
   and PRD T5; §4's manual reversal repair rule does not exempt terminal receipts from fee
   extraction. Recheck both counted-money and cumulative receipt totals independently.
   Only positive amount corrections are eligible for forced publication. Stale manifests
   fail atomically. Publication uses the existing publisher/outbox, one message per corrected
   donation and totals once per source Channel/Event per invocation. Native update opt-in
   is unchanged. It queues only; normal backend dispatch sends later. Record the publication
   receipt; **do not rerun applied publication** casually (it intentionally replays alerts).

10. Opt only capable NATIVE Destinations into `donation.updated` through the existing
    Destination editor/API, preserving their other `event_types`. TILTIFY format stays
    unchanged. Decide update opt-in before publication if native correction delivery is
    required; enabling it afterward does not replay missed updates automatically.
11. At next go-live, populate each Channel's ordered `default_goals` list (own/shared goals),
    inspect live fallback and own/shared scope, activate the primary Channel then other
    intended Channels, then activate the Event. Ended Events require explicit reviewed
    Undo End first. Remove the external freeze only after all financial, binding, caller
    and consumer acceptance gates pass.

### Parent callers and isolated rehearsal

The ESA parent `scripts/` and `staging/` are **not Git repositories**. The necessary
caller changes are versioned here as `scripts/parent-pledge-callers.patch`, not untracked
edits to parent files. The patch changes only the two callers and the matrix safety wrapper.
After integration, apply it from the ESA root (never the dono root):

```bash
# ESA_ROOT must be the explicit parent directory; PATCH the absolute tracked patch path.
cd "$ESA_ROOT"
git apply --check "$PATCH"
git apply "$PATCH"
git apply --reverse --check "$PATCH"
```

Git apply was verified in a standalone directory without `.git`; GNU patch is not needed.
If `--check` fails, stop and manually reconcile unrelated parent edits; do not force it.
If the parent already has an earlier version of this patch, first reverse that version
(`git apply --reverse` with the patch from the earlier commit), then apply this one.
`python3 scripts/check-parent-pledge-callers.py --parent-root "$ESA_ROOT"` from the dono
checkout checks application and syntax on private copies, then compiles and executes only
its extracted `purchase` function with mocked HTTP/API responses and independent literal
fixtures (including a rejected bad-amount control). It uses no network or containers and
does not execute the caller's top-level runtime or the staging probe's behavior.
When run in the sandbox, the public caller obtains a real 409 corrected review then
confirms it, uses explicit D and the admin **simulated settled-intake** boundary with
token/new money/external id.
It does **not** fabricate unbound Stripe success or relax production exact-Session checks.
The direct staging caller uses the shared planner and a stable draft. Direct PHYSICAL
Wallet claims must return 400 with no debit/claim/stock change; cash-backed physical
pledges still fulfill. Nonphysical direct Wallet spends are not new donations.

Rehearse a fresh dedicated `esa-e2e-*` Compose project: `--env-file /dev/null`, unique
localhost ports, fresh volumes/overlay, synthetic credentials and no Stripe/SMTP/OAuth.
Resolve configuration into a private virtual root: point dono build contexts at the
integration worktree, siblings at their current source, and assign unique local image
tags. Parent Compose defaults otherwise build the main checkout, not this worktree.
Do not change shared build/CI configuration or sibling source. Run the patched
`scripts/test-incentives.sh` and the patched staging probe only with explicit owned
`--engine`, `--sandbox-project`, `--backend`, `--overlay`, `--channel-slug` inputs.
The staging probe refuses defaults and mismatched project labels before reading a key.
No live-looking default containers, reused overlays, schedules or deployment APIs are
allowed. Tear down only that project/volumes and its private engine socket/helpers.
Record exact producer, Kollekt and overlay source/image hashes and actual results for
public and direct callers, browser/staff workflows, per-target allocation values, repeated
updates and cold/warm cross-Channel hydration. Keep unrun/failed gates explicit; a partial
matrix, unit tests or an applied caller patch is **not full E2E success**.

### Rollback without erasing writes

Restore **both** the original backup and previous pinned image only when no application
or delivery write occurred after the backup. Never mount the final-schema DB into the
old image. The external freeze must cover staff, late Stripe receipts, workers and direct
SQLite access, not merely inactive Channels. Without proof, fix forward/manual review.

A concrete final-schema diagnostic (SQLite dates can be integer milliseconds or text):

```sql
-- Bind :backup_ms to the recorded UTC backup instant in milliseconds.
WITH dates(scope, id, at) AS (
 SELECT 'Donation', id, created_at FROM Donation
 UNION ALL SELECT 'Donation', id, moderated_at FROM Donation
 UNION ALL SELECT 'Donation', id, shipping_recorded_at FROM Donation
 UNION ALL SELECT 'Donor', id, updated_at FROM Donor
 UNION ALL SELECT 'PendingPledge', id, updated_at FROM PendingPledge
 UNION ALL SELECT 'RewardClaim', id, updated_at FROM RewardClaim
 UNION ALL SELECT 'PollVote', id, created_at FROM PollVote
 UNION ALL SELECT 'PollVote', id, reversed_at FROM PollVote
 UNION ALL SELECT 'PollVote', id, allocated_at FROM PollVote
 UNION ALL SELECT 'FundContribution', id, created_at FROM FundContribution
 UNION ALL SELECT 'FundContribution', id, reversed_at FROM FundContribution
 UNION ALL SELECT 'FundContribution', id, allocated_at FROM FundContribution
 UNION ALL SELECT 'BalanceAdjustment', id, created_at FROM BalanceAdjustment
 UNION ALL SELECT 'PaymentRefund', id, updated_at FROM PaymentRefund
 UNION ALL SELECT 'PoolCredit', id, created_at FROM PoolCredit
 UNION ALL SELECT 'PoolCredit', id, cleared_at FROM PoolCredit
 UNION ALL SELECT 'PoolCreditBatch', id, created_at FROM PoolCreditBatch
 UNION ALL SELECT 'PoolCreditRedemption', id, created_at FROM PoolCreditRedemption
 UNION ALL SELECT 'EventEndAudit', id, created_at FROM EventEndAudit
 UNION ALL SELECT 'WebhookDelivery', id, updated_at FROM WebhookDelivery
), normalized AS (
 SELECT scope, id, at, CASE WHEN typeof(at) IN ('integer','real')
   THEN at ELSE unixepoch(at)*1000 END AS ms FROM dates
)
SELECT scope, count(DISTINCT CASE WHEN ms>:backup_ms THEN id END) AS dated_rows,
 count(DISTINCT CASE WHEN at IS NOT NULL AND ms IS NULL THEN id END) AS unknown_dates
 FROM normalized GROUP BY scope ORDER BY scope;
```

These counts are **diagnostics, never a no-write proof**: Donation has no `updated_at`,
PollOption/ChannelDefaultGoal have no timestamps, reductions can update old redemptions,
and deletes leave no timestamp at all. Migration-induced dates also appear. The checkpoint
hashes **every table's schema and full rows**, including timestamp-less joins, all ledgers,
auction/config/auth data and migration history, without exposing their secrets. Run while
all writers are stopped, on a stable snapshot:

```bash
node --import tsx server/scripts/transition-cli.ts rollback --database-url "$DB" \
  --checkpoint "$REPORTS/checkpoint.json" --report "$REPORTS/rollback-diagnostic.json"
# Add BOTH acknowledgements only with documented proof, not to bypass a failure:
node --import tsx server/scripts/transition-cli.ts rollback --database-url "$DB" \
  --checkpoint "$REPORTS/checkpoint.json" --freeze-ack --migration-review-ack \
  --report "$REPORTS/rollback-reviewed.json"
```

`SAFE_TO_RESTORE` requires an identical checkpoint **and** the operator's continuous-freeze
and migration-only-review attestations from backup through checkpoint/check. A checkpoint
created after unknown writes cannot establish safety. Any changed/deleted row, missing
checkpoint, unexplained migration delta or interrupted freeze means **FIX_FORWARD**.
The tool never restores, erases data, repairs history or grants deployment permission.

### Payment refund, Wallet refund and chargeback recovery

- **Wallet refund** keeps cash at the charity (`REFUNDED` still counts). Preview with
  `GET /api/admin/donations/:id/reversal-preview?status=REFUNDED`, then the existing status
  PATCH only after review. **Payment refund** returns original-payment-method cash for
  an eligible pending physical claim before Event end. Use
  `GET /api/admin/claims/:id/payment-refund-preview` and
  `POST /api/admin/claims/:id/payment-refund`; server eligibility and Pool shrink preview
  are authoritative. Never run SQL to mimic either action.
- `REQUESTED` holds the claim CANCELLING and locks conflicting changes. Lost responses
  are uncertain, not failed. Use `POST /api/admin/payment-refunds/:id/retry`; it discovers
  Stripe's original refund by durable metadata/key, without creating a fresh refund key.
  Check the exact payment, receipt and dashboard before escalation.
- **Acceptance is not settlement.** On accepted pending/requires_action/succeeded the
  application lowers item money, D, donor total and Pools once and returns stock. Shipping
  is separately refunded only with the last physical claim. A `REQUIRES_ACTION` total can
  therefore be lower than settled bank cash. Do not manually add it back while awaiting
  action/settlement. Reconcile/retry and inspect the provider's required action.
- Definite rejection before acceptance resolves REJECTED, restores PENDING and changes
  no money. Accepted **failed/canceled later** stays FAILED with prior accounting intact.
  Resolve item once using `POST /api/admin/payment-refunds/:id/resolve-item` and one of
  `RETURNED_OUTSIDE_APP`, `WALLET_CREDIT`, `SETTLED_BY_DISPUTE`. Wallet credit restores ITEM
  money/D/donor total and available Wallet, not shrunken allocations; the Pool gap remains
  unavailable. It is allowed only for COMPLETED/REFUNDED, never CHARGEBACK. Dispute resolution
  requires CHARGEBACK. Record external return evidence; do not mark settled merely to clear
  the queue. Identical repeats are idempotent; different choices conflict.
- Failed shipping is independent, remains discoverable even after item resolution, and
  **never becomes Wallet or donation money**. Use
  `POST /api/admin/payment-refunds/:id/resolve-shipping` with `RETURNED_OUTSIDE_APP` or
  `KEPT_BY_AGREEMENT`. Use the default open `GET /api/admin/payment-refunds` list to find
  outstanding item AND shipping decisions. Never apply an item resolution to shipping.
- For a later dispute, compare the **full original charge**, accepted/refunded item and
  shipping, current `amount_cents`, and provider dispute amount. Preview CHARGEBACK via
  the reversal-preview endpoint before recording it. The app removes only **remaining
  counted donation money**, once; it does not subtract a previously accepted Payment
  refund again. A full-charge dispute may exceed that remaining money (or include shipping).
  Handle that external excess with Stripe/accounting support, not negative donations or
  repeated reversals. Late refund failure after chargeback permits outside return/dispute
  resolution, never Wallet credit; acknowledge flagged shipped claims after investigation.
- Stripe processing fees retained on refunds and dispute fees are expenses outside donation,
  shipping, incentive and counted-money totals. Reconcile fees in the charity's external
  books, not by reducing donation amounts. Endpoint API-version checks, subscription changes,
  dashboard actions and real payment/refund exercises require separate human authorization.

---

## Agent operating guide

Non-obvious invariants and deterministic procedures agents must follow.

### Credential transport (ADR 0004)

Everything travels in one header — `Authorization: Bearer <token>` with a
namespace prefix:

| Prefix                    | Meaning                                         |
| ------------------------- | ----------------------------------------------- |
| `key_admin_<key>`         | operational admin key (`ADMIN_API_KEY`)         |
| `key_mod_<key>`           | operational moderator key (`MODERATOR_API_KEY`) |
| `key_metrics_<key>`       | metrics key (`METRICS_API_KEY`)                 |
| `donor_<token>` (or bare) | donor magic token                               |

The legacy `?token=` query param was **removed** — donor spend APIs must use the
`dono_session` httpOnly cookie (browser) or a `Bearer` token (API). The
`X-Admin-Key` header is honoured only as a deprecated shim; do not add new code
that uses it.

```bash
# health
curl -s http://localhost:3001/api/health

# admin stats (canonical form)
curl -s -H "Authorization: Bearer key_admin_$ADMIN_API_KEY" http://localhost:3001/api/admin/stats

# simulate a donation (returns { token, donor })
curl -s -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Authorization: Bearer key_admin_$ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","amount_cents":1000}'

# metrics
curl -s -H "Authorization: Bearer key_metrics_$METRICS_API_KEY" http://localhost:3001/api/metrics
```

### Critical invariants

1. **Webhook route order.** `/api/webhooks/stripe` must stay mounted before
   `express.json()` in `server/index.ts` — it needs the raw body for HMAC
   verification. Do not reorder middleware.
2. **`ADMIN_API_KEY` is required** in production; `docker-compose.yml` uses
   `${ADMIN_API_KEY:?...}` so compose refuses to start without it.
3. **SQLite lives on the `/data` volume.** A backend container restarted
   without the volume has an empty DB and all donors vanish. Never remove
   `dono-data` except during a deliberate reset.
4. **Run as non-root.** Both images run as non-root users (`dono` UID 1001;
   `nginx`). Build/runtime steps that `chown` or write to `/data` assume this.
5. **Money is integer cents** everywhere (`@dono/shared` branded `Cents` type).
6. **Never expose `donor.email`** from `/api/moderator/*` handlers — only
   `server/routes/admin.ts` may return email. A CI test statically scans the
   moderator file for this regression.
7. **Role escalation is impossible via donation.** Roles come only from the
   `ADMIN_EMAILS`/`MODERATOR_EMAILS` allowlists (gated on a verified OAuth
   email) or an explicit `PATCH /api/admin/donors/:id/role`.
8. **`npm run db:generate --workspace server` must run** before `typecheck`/`test`.
   Both Prisma clients and the derived PostgreSQL schema are generated, not
   committed. CI does this; repeat locally after installation or a model change.
9. **`TRUST_PROXY` equals the number of proxies in front of the backend**
   (the frontend nginx counts as one). Adding or removing a proxy (TLS
   terminator, load balancer, CDN) changes it. Wrong in either direction breaks
   the per-IP rate limits: too low, one bucket for everyone; too high, spoofable.
   See § Client IP and `TRUST_PROXY`.
10. **`DATABASE_URL` path resolution.** The Prisma CLI resolves a relative SQLite
    URL against the schema directory; the generated PrismaClient resolves it
    against `process.cwd()`. Use an absolute `file:` URL when both must open the
    same file. Server tests are not affected: each vitest run migrates its own
    temp DB at an absolute path (`server/test/global-setup.ts`), so neither CI
    nor the Docker `test` target prepares a database.

### Agent pre-flight / verification checklist

```bash
# 1. typecheck + tests (must run via npm, not npx vitest)
npm run typecheck && npm run test:ci

# 2. build the client (Vite)
npm run build

# 3. build both images
docker build -f Dockerfile.backend --target runtime -t esa-dono-ui/backend:latest .
docker build -f Dockerfile.frontend -t esa-dono-ui/frontend:latest .

# 4. boot + functional smoke test (always tears down)
ADMIN_API_KEY=change-me FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

The smoke test asserts: backend health through the nginx proxy, SPA index +
client-route fallback, admin auth enforcement (401/200), an end-to-end donation
write (proving migrations + DB writes), and volume persistence across a backend
restart. All seven checks must pass before a change is considered deployable.

### Scaling notes

For high-traffic campaigns, see the README's "Future / Production at Scale"
diagram: horizontally scale frontend replicas behind a load balancer (one more proxy
hop: raise `TRUST_PROXY`; with several backend replicas the in-memory rate-limit
counters are per replica, so the effective limit multiplies), scale the
backend tier only after adding database-backed coordination for webhook dispatch.
PostgreSQL is selected by `DATABASE_URL` in the same image, but financial transactions
remain serialized and database selection does not transfer existing SQLite data.
Read replicas and a dedicated webhook-sender container remain future work.
