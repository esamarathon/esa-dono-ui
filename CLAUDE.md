# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (root, installs all workspaces)
npm install

# Run dev (server :3001 + client :5173 via concurrently)
npm run dev

# Build client only
npm run build

# DB migrations (run from server/)
cd server && npx prisma migrate dev --name <name>
cd server && npx prisma generate

# DB studio
cd server && npx prisma studio

# Typecheck (tsc --noEmit per workspace)
npm run typecheck

# Tests (vitest, per-workspace configs — run from root)
npm run test:ci          # lint-free CI run (junit reporter)
npm test                 # all workspace tests
npm run test --workspace server   # server only
npm run test --workspace client   # client only
```

Note: run tests via the npm scripts above (per-workspace vitest configs). Running
`npx vitest` from the repo root uses the wrong environment and will fail.

## Language / TypeScript

The codebase is **TypeScript (strict)** across both workspaces (see
`docs/adr/0001-typescript-for-frontend-and-backend.md`). Key points:

- **Server** runs `.ts` directly via **`tsx`** (`tsx watch index.ts` in dev, `tsx index.ts`
  in prod) — no build/emit step. `npm run typecheck --workspace server` runs `tsc --noEmit`.
  NodeNext ESM: relative imports **keep the `.js` extension** even though sources are `.ts`.
- **Client** is compiled by Vite (`react-jsx`, `bundler` resolution) — relative imports are
  **extensionless**. `tsc --noEmit` for typecheck.
- **`packages/shared`** (`@dono/shared` workspace) holds cross-cutting types consumed by both
  sides: branded `Cents` money helpers, Tiltify webhook payload types, and `claim_data` helpers.
  It ships as raw `.ts` (no build) via its `exports`/`main` pointing at source.
- `tsconfig.base.json` at the root holds the strict baseline; each workspace extends it.
- Tests are TypeScript (`.test.ts`/`.test.tsx`). Config files are TypeScript too
  (`vite.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `eslint.config.ts` — the
  last loaded via `jiti`). `allowJs` is **off**. The **only** remaining JavaScript file is
  `client/postcss.config.js`: Vite's bundled `postcss-load-config` cannot load a `.ts`
  PostCSS config, so it must stay `.js`. No `.js`/`.jsx` source or test files remain.

## Docker Deployment

Two production images (mirrors the esa-waypoint split backend/frontend pattern):

- **`Dockerfile.backend`** — Express + Prisma API. Multi-stage:
  - `test` target: full dev deps + source, entrypoint runs `scripts/run-tests.mjs` (used by CI `container-test`).
  - `runtime` target: production API. Applies `prisma migrate deploy` on startup via `docker-entrypoint.backend.sh`, runs non-root, SQLite lives in the `/data` volume (`DATABASE_URL=file:/data/dono.db`), health check on `/api/health`.
- **`Dockerfile.frontend`** — builds the Vite SPA and serves it via `nginx-unprivileged` on port 8080. `nginx.conf` (templated to `default.conf.template`) does SPA fallback and proxies `/api/` → `http://backend:3001`. Uses the built-in `15-local-resolvers` script (`NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1`) so DNS resolution works on both Docker and Podman.

```bash
# Local full stack (needs ADMIN_API_KEY at minimum)
ADMIN_API_KEY=change-me docker compose up --build
# Frontend on http://localhost:8080 (proxies /api to backend). SQLite persisted in the dono-data volume.
```

### Verify the containers actually run

After building, always confirm the stack _functions_ — not just that the images build. `scripts/smoke-test.sh` boots the compose stack and asserts: backend health through the nginx proxy, SPA index + client-route fallback, admin-auth enforcement (401/200), an end-to-end donation simulation (proves migrations + DB writes), and volume persistence across a backend restart. It always tears the stack down on exit.

```bash
ADMIN_API_KEY=change-me FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

The CI `container-test` job runs this against the freshly built runtime images, and `docker-publish.yml` runs it against the just-pushed `:latest` images after the Trivy gate.

Images publish to `ghcr.io/codescales/esa-dono-ui/{backend,frontend}` via
`.github/workflows/docker-publish.yml` (buildx multiarch amd64/arm64 + Trivy CRITICAL gate) on push to `main`.

## Bootstrap

```bash
cp .env.example .env   # fill in values
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..
npm run dev
```

## Architecture

npm workspaces monorepo: `server/` (Express + Prisma + SQLite), `client/` (React + Vite + Tailwind), and `packages/shared` (`@dono/shared`, cross-cutting TypeScript types). In dev, Vite proxies all `/api` requests to `localhost:3001` (`client/vite.config.js`).

### Server

- `server/index.ts` — Express entry point. The Tiltify webhook route **must** be mounted before `express.json()` because it needs the raw body buffer for HMAC verification.
- `server/lib/prisma.ts` — Prisma singleton using `globalThis` cache to survive hot reloads.
- `server/services/tiltify.ts` — OAuth2 client-credentials token fetch with in-memory cache (refreshed ~60s before expiry). Calls Tiltify v5 API. Supports multiple scopes (`public`, `webhooks:write`).
- `server/services/donation.ts` — Shared `processDonation()` (upserts donor + donation, sends magic link, auto-fulfills pledge) used by both webhook and simulation. Also exports `checkBlockedWords()` for custom poll entry validation.
- `server/services/spend.ts` — Reusable `tx`-aware spend helpers (`claimRewardTx`, `votePollTx`, `contributeGoalTx`) shared between HTTP routes and pledge fulfillment.
- `server/services/pledge.ts` — Pledge lifecycle: `createPledge()` (validates items, persists `PendingPledge`), `resolvePledge()` (by token or email fallback), `fulfillPledge()` (executes items inside a donation transaction), `createRelayForPledge()` (creates Tiltify relay key for deterministic linkage).
- `server/services/email.ts` — Nodemailer magic link sender; called fire-and-forget from the webhook handler.
- `server/middleware/adminAuth.ts` — Checks `X-Admin-Key` header against `ADMIN_API_KEY` env var.
- `server/middleware/donorAuth.ts` — Resolves `?token=` query param to a `Donor` record; sets `req.donor`.
- `server/middleware/moderatorAuth.ts` — Chains `donorAuth` then checks `req.donor.is_moderator`. Moderator access via magic link, no separate API key.
- `server/routes/moderator.ts` — Moderator CRUD for polls, rewards, goals, claims, and custom entry approval.

### Moderator Setup

Set `MODERATOR_EMAILS` env var to a comma-separated list of emails. When a donation webhook fires for a matching email, the donor gets `is_moderator: true`. Moderators access their dashboard via their magic link — the Navbar shows a "Moderate" link when `is_moderator` is true. Moderators can CRUD polls/rewards/goals, view/fulfill claims, and approve custom poll entries. They cannot access `/api/admin/*` routes (require `X-Admin-Key`).

### Webhook flow (`server/routes/webhook.ts`)

1. HMAC-SHA256 verify (`x-tiltify-signature` + `x-tiltify-timestamp`). Skipped if `TILTIFY_WEBHOOK_SECRET` is unset (useful for local testing).
2. Handles both standard `donation.completed` events and `private:relay:donation_updated` relay events. For relay events, extracts `pledge_token` from `meta.relay_key_id` and only processes `payment_status: completed`.
3. Delegates to `processDonation()` in `server/services/donation.ts` — upserts donor (credits balance, extends token TTL without rotating, sets `is_moderator` only when matching), creates donation (P2002 = duplicate → no-op), resolves and fulfills any matching pledge, fire-and-forget sendMagicLink.

### Pledge / Cart Flow

The smart donation cart lets donors select incentives before donating. The flow:

1. **Client**: User browses rewards/polls/goals in a guided stepper (`/donate`), builds a cart.
2. **Server**: `POST /api/pledge` creates a `PendingPledge` with `PledgeItem`s, validates all items against live state, computes `total_cents`. Optionally creates a Tiltify Webhook Relay key for deterministic donation→pledge linkage.
3. **Client**: User is redirected to Tiltify donate URL (with `?relay=<client_key>` if relay is configured).
4. **Tiltify**: Fires `private:relay:donation_updated` webhook with `meta.relay_key_id` = `pledge_<pledge_token>`.
5. **Server**: Webhook extracts pledge token, calls `processDonation({ pledgeToken })`. Inside the transaction, `resolvePledge()` finds the matching pledge (by token, or email fallback), then `fulfillPledge()` replays each item through the shared spend helpers. Remainder stays as `balance_remaining`.
6. **Fallback**: If relay linkage fails, `resolvePledge()` falls back to email+amount matching (newest OPEN pledge with `total ≤ amount` within 2h window). If nothing matches, full amount → `balance_remaining` (today's behavior). Money is never lost.

### Balance mutations

All balance changes (reward claims, poll votes, goal contributions) use `prisma.$transaction` with the shared `tx`-aware helpers in `server/services/spend.ts` to keep `Donor.balance_remaining` and the associated record creation atomic. Both HTTP routes and pledge fulfillment use the same helpers.

### Client

- `client/src/api/client.ts` — axios instance that auto-attaches `?token=` from `localStorage.donor_token` to every request.
- `client/src/api/admin.ts` — separate axios instance that auto-attaches `X-Admin-Key` from `localStorage.admin_key`.
- `client/src/api/moderator.ts` — axios instance that auto-attaches `?token=` from `localStorage.donor_token` for moderator routes.
- `client/src/pages/MyWallet.tsx` — reads `?token=` from the URL on mount and persists it to localStorage.
- `client/src/pages/admin/AdminLayout.tsx` — renders a key-entry gate if `localStorage.admin_key` is absent; logout clears the key.

### Database

SQLite via Prisma. All monetary values are **integer cents**. `RewardClaim.claim_data` is a JSON string (SQLite has no native JSON column); routes must `JSON.parse`/`JSON.stringify` it. To migrate to Postgres, change `datasource.provider` and `DATABASE_URL`.

## Environment Variables

| Variable                                      | Purpose                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `TILTIFY_CLIENT_ID` / `TILTIFY_CLIENT_SECRET` | OAuth2 creds for Tiltify v5 API                                   |
| `TILTIFY_CAMPAIGN_ID`                         | Campaign to proxy from Tiltify                                    |
| `TILTIFY_DONATE_URL`                          | Static donate URL (fallback when relay is not configured)         |
| `TILTIFY_DONATE_ID`                           | Campaign identifier in donate URL (e.g. UUID or `@username/slug`) |
| `TILTIFY_WEBHOOK_RELAY_ID`                    | Webhook Relay ID from Tiltify Developer Dashboard                 |
| `TILTIFY_WEBHOOK_SECRET`                      | HMAC secret; omit to disable signature checking locally           |
| `ADMIN_API_KEY`                               | Sent as `X-Admin-Key` from admin UI                               |
| `MODERATOR_EMAILS`                            | Comma-separated emails auto-promoted to moderator on donation     |
| `SMTP_*` / `EMAIL_FROM`                       | Nodemailer config                                                 |
| `APP_BASE_URL`                                | Base URL for magic links in emails (e.g. `http://localhost:5173`) |
| `PORT`                                        | Server port, default `3001`                                       |
| `DATABASE_URL`                                | Prisma DB URL, e.g. `file:./dev.db`                               |

## Local Webhook Testing

```bash
ngrok http 3001
# Register https://<ngrok-url>/api/webhooks/tiltify in Tiltify dashboard
# Omit TILTIFY_WEBHOOK_SECRET during dev to skip signature verification
```

### Simulate Donations (no real money)

**Option A — Admin UI:** Visit `/admin/simulate`, fill in donor email + amount, click "Simulate Donation". Copy the generated magic link to access the donor wallet.

**Option B — curl (full webhook path):** When `TILTIFY_WEBHOOK_SECRET` is unset, HMAC verification is skipped. POST directly:

```bash
curl -X POST http://localhost:3001/api/webhooks/tiltify \
  -H "Content-Type: application/json" \
  -d '{"meta":{"event_type":"donation.completed"},"data":{"id":"test-123","donor_email":"test@example.com","donor_name":"Test","amount":{"value":"10.00"},"comment":"test"}}'
```

**Option C — Admin API:** `POST /api/admin/simulate-donation` with `X-Admin-Key` header:

```bash
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: change-me" \
  -d '{"email":"test@example.com","amount_cents":1000}'
```

Returns `{ success: true, token, donor }`. Use the token to build a magic link: `http://localhost:5173/wallet?token=<token>`.
