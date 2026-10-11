# AGENTS.md

Instructions for coding agents working in this repository. `CLAUDE.md` only imports this file.

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

# DB seed (creates dev moderator/admin accounts + banner with API keys)
cd server && npx prisma db seed

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
  sides: branded `Cents` money helpers, Stripe webhook payload types, and `claim_data` helpers.
  It ships as raw `.ts` (no build) via its `exports`/`main` pointing at source.
- `tsconfig.base.json` at the root holds the strict baseline; each workspace extends it.
- Tests are TypeScript (`.test.ts`/`.test.tsx`). Config files are TypeScript too
  (`vite.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, and one `eslint.config.ts` per
  workspace — loaded via `jiti`). `allowJs` is **off**. The **only** remaining JavaScript file is
  `client/postcss.config.js`: Vite's bundled `postcss-load-config` cannot load a `.ts`
  PostCSS config, so it must stay `.js`. No `.js`/`.jsx` source or test files remain.

## Docker

Full deployment and operations guide: `docs/deployment.md`. Image and publish details:
`docs/architecture.md` § Container images.

```bash
# Local full stack (needs ADMIN_API_KEY at minimum); frontend on http://localhost:8080
ADMIN_API_KEY=change-me docker compose up --build

# After building, prove the stack functions (always tears down)
ADMIN_API_KEY=change-me FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

Behind an external proxy (Caddy, a TLS terminator, a load balancer), set **`TRUST_PROXY=2`**
(one more per extra proxy), or every visitor shares one rate-limit bucket (#140).

## Vocabulary

Read `CONTEXT.md` before naming anything. **Event** means the charity event (a marathon or
a one-day stream event). A notification sent to a Destination is a **webhook message** —
not an "event". Webhook code under `server/services/webhooks/` uses "message"
(`WebhookDestination`, `WebhookDelivery`, `message_type`, `emitWebhookMessage`); an ESLint
warning flags new `Event`-named identifiers there. The wire keeps "event" where it is an
external contract (`X-Webhook-Event`, `x-webhook-event`, admin API `event_types`,
delivery-log `event_type`). See `docs/adr/0006-webhook-vocabulary.md`.

## Invariants

Each of these has broken before or breaks silently. Detail: `docs/architecture.md`.

- The Stripe webhook route is mounted **before** `express.json()`: it needs the raw body for
  signature verification (`server/index.ts`).
- Inside a Prisma transaction, use the **`tx` client**. A query on the global `prisma` waits for
  the transaction and times out (SQLite `connection_limit=1`, ADR-0007).
- Webhook messages are emitted only through `withWebhooks(fn)`
  (`server/services/webhooks/outbox.ts`), so they commit or roll back with the change.
- **Moderator routes never return donor email.** Only `server/routes/admin.ts` may. See the
  invariant comment at the top of `server/routes/moderator.ts` and
  `server/test/routes/moderator-donor-email.test.ts`.
- Roles are never granted by donating. Allowlist roles (`ADMIN_EMAILS`/`MODERATOR_EMAILS`) need
  `Donor.email_verified` (`server/lib/roles.ts`).
- Money is integer cents. Money totals count `COMPLETED` and `REFUNDED` donations through
  `server/lib/donationTotals.ts`; incentive totals are never money totals.
- Balance changes go through the `tx`-aware helpers in `server/services/spend.ts`.
- `RewardClaim.claim_data` is a JSON string (SQLite has no JSON column).
- Every pledge routes to exactly one active Channel; a donation is never reassigned (409).
  A slug cannot change while its Event or Channel is active.

## Where to look

- `docs/architecture.md`: server, auth and roles, Stripe webhook flow, pledge flow, Events and
  Channels, client, database, OpenTelemetry, container images.
- `docs/environment-variables.md`: every environment variable.
- `docs/local-development.md`: bootstrap and the dev seed (accounts and the API-key banner).
- `docs/simulating-donations.md`: simulate donations, record external donations (#62), the
  seeded simulator.
- `docs/outbound-events.md` and `docs/webhooks-and-metrics.md`: webhook messages, consumer setup,
  metrics.
- `docs/api-consumers.md`: callers of this API in sibling repos. Check it before changing an
  endpoint or a response field.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `esamarathon/esa-dono-ui` (`origin`) — managed via the `gh -R esamarathon/esa-dono-ui` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
