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
- **Data**: SQLite via Prisma, single file. All money is integer cents.
- **Production** ships two images: `backend` (Express, non-root `dono`, UID 1001) and `frontend` (nginx-unprivileged SPA, proxies `/api/` → backend).

```
Donor/Browser → nginx (frontend :8080) ──/api/*──→ backend (Express :3001) → SQLite (/data/dono.db)
Stripe webhook → backend /api/webhooks/stripe (raw body, before express.json)
```

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
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..
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

> **Note:** `seed-dev.sh` predates the current auth transport and uses the
> deprecated `?token=` query param for some spend calls, so those steps may
> fail. Use the admin UI (`/admin/simulate`) or the curl commands below
> instead. It is retained for reference only.

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
docker build -f Dockerfile.backend --target runtime -t ghcr.io/codescales/esa-dono-ui/backend:latest .
docker build -f Dockerfile.frontend             -t ghcr.io/codescales/esa-dono-ui/frontend:latest .
```

Or pull the CI-published multiarch images (amd64/arm64):

```bash
docker pull ghcr.io/codescales/esa-dono-ui/backend:latest
docker pull ghcr.io/codescales/esa-dono-ui/frontend:latest
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
```

### 3. Start

```bash
docker compose --env-file .env.production up -d --build
# or, with images already built/pulled:
docker compose --env-file .env.production up -d
```

- Frontend: `http://localhost:8080` (port via `FRONTEND_PORT`, default 8080).
- SQLite persisted in the named volume `dono-data` (mounted at `/data`).
- Backend runs `prisma migrate deploy` on every startup (entrypoint) — safe to
  redeploy new images without manual DB steps.

### 4. Verify

```bash
curl -s http://localhost:8080/api/health        # → {"ok":true,"db":true}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/rewards   # → 200 (SPA fallback)
```

Full end-to-end validation (tears the stack down on exit):

```bash
ADMIN_API_KEY=… FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

### 5. External reverse proxy (optional)

Point TLS at the frontend container (`:8080`) and let it proxy `/api/`:

```nginx
server {
  listen 443 ssl;
  server_name donations.example.com;
  location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
```

Caddy: `reverse_proxy /* 127.0.0.1:8080`

> The frontend container already forwards `/api/*` to `dono-backend:3001`, so
> an external proxy only needs to reach the frontend.

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

Restore: stop the backend, copy the file back into the volume, restart.

### Migrations

Handled automatically by the backend entrypoint (`prisma migrate deploy`). To
create a new migration during development:

```bash
cd server && npx prisma migrate dev --name <name> && npx prisma generate && cd ..
```

### Rollback

Redeploy a previous image tag (CI also tags `backend:<sha>` / `frontend:<sha>`):

```bash
docker compose pull && docker compose up -d
# or pin a specific build:
docker tag ghcr.io/codescales/esa-dono-ui/backend:<sha> ghcr.io/codescales/esa-dono-ui/backend:latest
```

DB migrations are append-only; rolling back an image with a schema change may
require a manual DB restore from backup.

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
8. **`prisma generate` must run** before `typecheck`/`test` (the Prisma client is
   generated, not committed). CI does this; replicate locally after any schema
   change.
9. **`DATABASE_URL` path resolution.** The Prisma CLI resolves a relative SQLite
   URL against the schema directory; the generated PrismaClient resolves it
   against `process.cwd()`. The Docker `test` target pins an absolute
   `file:/app/server/prisma/dev.db` to sidestep the mismatch (see the comment in
   `Dockerfile.backend`). Keep these in sync with `server/vitest.config.ts`.

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
diagram: horizontally scale frontend replicas behind a load balancer, scale the
backend tier, and migrate SQLite → PostgreSQL (`datasource.provider` +
`DATABASE_URL`) with a read replica. A dedicated webhook-sender container is the
future path to decouple webhook ingestion from API serving.
