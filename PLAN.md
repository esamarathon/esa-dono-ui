# Plan: Dono-UI Donation Platform

## Context

Build a greenfield Node.js + React donation platform integrated with Tiltify. Tiltify handles all payment processing; this app receives donation events via webhook, credits donor balances, and lets donors spend those balances on rewards, polls, and pooled fund goals. No user accounts — donors are identified by email and access their wallet via a magic link token emailed after each donation.

**User choices:**

- Auth: Anonymous (magic token via email)
- Admin: Full CRUD UI at `/admin`, protected by API key
- Moderator: Magic-link based, CRUD polls/rewards/goals + approve custom poll entries. No access to blocked words, simulation, or donor data.
- Rewards: Digital codes, physical items (with address collection), shoutouts, character selection, game difficulty (CUSTOM type)
- Polls: Donation-weighted ($1 = 1 vote). Custom entries with moderator approval gate, per-poll char limits, global blocked-words dictionary.

---

## Tech Stack

- **Frontend**: React 18 + Vite 5, TailwindCSS 3, React Router v6
- **Backend**: Node.js + Express 4, ESM (`"type": "module"`)
- **Database**: SQLite via Prisma ORM (all monetary values in integer cents)
- **Email**: Nodemailer (configurable SMTP)
- **Monorepo**: npm workspaces (`client/`, `server/`)
- **Concurrency**: `concurrently` for dev

---

## Environment Variables (`.env.example`)

```
TILTIFY_CLIENT_ID=
TILTIFY_CLIENT_SECRET=
TILTIFY_CAMPAIGN_ID=
TILTIFY_WEBHOOK_SECRET=
ADMIN_API_KEY=change-me
MODERATOR_EMAILS=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM="Donation Platform <no-reply@example.com>"
APP_BASE_URL=http://localhost:5173
PORT=3001
DATABASE_URL="file:./dev.db"
```

---

## Database Models (`server/prisma/schema.prisma`)

- **Donor** — `email` (unique), `total_donated`, `balance_remaining`, `magic_token` (unique), `token_expires_at`, `is_moderator`
- **Donation** — `tiltify_id` (unique), `donor_id`, `amount_cents`, `donor_name`, `comment`
- **Reward** — `title`, `description`, `type` (DIGITAL|PHYSICAL|SHOUTOUT|CUSTOM), `cost_cents`, `quantity_total` (nullable=unlimited), `quantity_claimed`, `is_active`, `custom_type_label`
- **RewardClaim** — `reward_id`, `donor_id`, `status` (PENDING|FULFILLED), `claim_data` (JSON string: address/preferences)
- **Poll** — `title`, `description`, `is_active`, `ends_at`, `total_votes_cents`, `allow_custom_entries`, `max_entry_chars`
- **PollOption** — `poll_id`, `label`, `votes_cents`, `custom_entry_id` (nullable FK to PollCustomEntry)
- **PollVote** — `poll_id`, `poll_option_id`, `donor_id`, `amount_cents`
- **PollCustomEntry** — `poll_id`, `donor_id`, `label`, `status` (PENDING|APPROVED|REJECTED)
- **BlockedWord** — `word` (unique)
- **FundGoal** — `title`, `description`, `target_cents`, `current_cents`, `is_active`, `is_complete`
- **FundContribution** — `goal_id`, `donor_id`, `amount_cents`

---

## Project Structure

```
dono-ui/
├── package.json              # root workspace + concurrently dev script
├── .env / .env.example
├── server/
│   ├── package.json
│   ├── index.js              # Express app, middleware order (webhook raw BEFORE json)
│   ├── lib/prisma.js         # Prisma singleton (globalThis cache for hot reload)
│   ├── prisma/schema.prisma
│   ├── services/
│   │   ├── tiltify.js        # OAuth2 token cache + getCampaign/getDonations
│   │   ├── email.js          # Nodemailer sendMagicLink()
│   │   └── donation.js       # Shared processDonation() + checkBlockedWords()
│   ├── middleware/
│   │   ├── adminAuth.js      # X-Admin-Key header check
│   │   ├── donorAuth.js      # ?token= query param → req.donor
│   │   └── moderatorAuth.js  # donorAuth + is_moderator check
│   └── routes/
│       ├── webhook.js        # POST /api/webhooks/tiltify (raw body, HMAC verify)
│       ├── campaign.js       # GET /api/campaign (proxies Tiltify)
│       ├── donor.js          # GET /api/donor (donorAuth)
│       ├── rewards.js        # GET /api/rewards, POST /api/rewards/:id/claim
│       ├── polls.js          # GET /api/polls, POST /api/polls/:id/vote, POST /:id/custom-entry
│       ├── goals.js          # GET /api/goals, POST /api/goals/:id/contribute
│       ├── admin.js          # All CRUD under /api/admin/* (adminAuth)
│       └── moderator.js      # Moderator CRUD for polls/rewards/goals/claims + entry approval
└── client/
    ├── package.json
    ├── vite.config.js        # proxy /api → localhost:3001
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── index.css          # @tailwind base/components/utilities
        ├── App.jsx            # React Router: admin, moderator, public routes
        ├── api/
        │   ├── client.js      # axios instance, auto-attach donor token from localStorage
        │   ├── campaign.js
        │   ├── donor.js
        │   ├── rewards.js
        │   ├── polls.js
        │   ├── goals.js
        │   ├── admin.js       # admin axios instance, auto-attach X-Admin-Key
        │   └── moderator.js   # moderator axios instance, auto-attach donor token
        ├── components/
        │   ├── Navbar.jsx
        │   ├── Card.jsx
        │   ├── Modal.jsx
        │   ├── ProgressBar.jsx
        │   └── LoadingSpinner.jsx
        └── pages/
            ├── Home.jsx            # Campaign name/desc, ProgressBar for raised/goal
            ├── MyWallet.jsx        # Read ?token=, store localStorage, show balance + claims
            ├── Rewards.jsx
            ├── Polls.jsx           # Polls + custom entry suggestion UI
            ├── Goals.jsx
            ├── admin/
            │   ├── AdminLayout.jsx     # API key login gate + sidebar nav
            │   ├── AdminDashboard.jsx  # Stats summary
            │   ├── AdminRewards.jsx    # Full CRUD table + create/edit modal
            │   ├── AdminPolls.jsx      # Full CRUD + options management + new fields
            │   ├── AdminGoals.jsx      # Full CRUD + progress display
            │   ├── AdminDonations.jsx  # Donations list + Claims table
            │   ├── AdminBlockedWords.jsx # Blocked words management
            │   └── AdminSimulate.jsx   # Donation simulation form
            └── moderator/
                ├── ModeratorLayout.jsx    # Sidebar nav (no key, uses donor token)
                ├── ModeratorDashboard.jsx # Pending entries + stats
                ├── ModeratorPolls.jsx     # Poll CRUD + pending entry approval
                ├── ModeratorRewards.jsx   # Reward CRUD
                ├── ModeratorGoals.jsx     # Goal CRUD
                └── ModeratorClaims.jsx    # Claims list + fulfill toggle
```

---

## Implementation Tasks

### Task 1: Database Foundation

**Blocked by:** None

Add new models (`BlockedWord`, `PollCustomEntry`) and fields (`Poll.allow_custom_entries`, `Poll.max_entry_chars`, `PollOption.custom_entry_id`, `Donor.is_moderator`) to schema. Run migration. Extract shared `processDonation()` from webhook.js into `server/services/donation.js`.

**Acceptance criteria:**

- [ ] `npx prisma migrate dev` succeeds with new schema
- [ ] `server/services/donation.js` exports `processDonation()`
- [ ] Webhook still works through the shared function
- [ ] `MODERATOR_EMAILS` env var added to `.env.example`

### Task 2: Donation Simulation

**Blocked by:** Task 1

Admin can simulate a donation and get a magic link. `POST /api/admin/simulate-donation` generates fake `tiltify_id`, calls `processDonation()`. New `AdminSimulate.jsx` page with form + magic link output.

**Acceptance criteria:**

- [ ] POST to `/api/admin/simulate-donation` creates donor, credits balance, returns token
- [ ] Duplicate email stacks balance (upsert)
- [ ] Admin UI form works, shows clickable magic link
- [ ] CLAUDE.md updated with curl example

### Task 3: Blocked Words Management

**Blocked by:** Task 1

Admin manages global blocked-words dictionary. `GET/POST/DELETE /api/admin/blocked-words`. New `AdminBlockedWords.jsx` page. Shared `checkBlockedWords(text)` util.

**Acceptance criteria:**

- [ ] Admin can add/delete blocked words via UI
- [ ] Whole-word, case-insensitive matching
- [ ] "badger" does NOT match "bad"

### Task 4: Moderator Auth Infrastructure

**Blocked by:** Task 1

Moderator emails from `MODERATOR_EMAILS` get `is_moderator: true` on webhook. New `moderatorAuth.js` middleware. New `server/routes/moderator.js` scaffold. New `api/moderator.js` client.

**Acceptance criteria:**

- [ ] Webhook for moderator email sets `is_moderator: true`
- [ ] Non-moderator hitting `/api/moderator/*` gets 403
- [ ] `api/moderator.js` attaches donor token

### Task 5: Custom Poll Entry — Donor Submission

**Blocked by:** Tasks 1, 3

`POST /api/polls/:id/custom-entry` validates poll state, char limit, blocked words, creates PENDING entry. `Polls.jsx` shows "Suggest an Option" on eligible polls. AdminPoll create/edit gains new fields.

**Acceptance criteria:**

- [ ] Eligible polls show suggestion UI with char counter
- [ ] Blocked word → rejected with clear error
- [ ] Valid submission → PENDING in DB
- [ ] Admin can toggle `allow_custom_entries` and set `max_entry_chars`

### Task 6: Custom Poll Entry — Moderator Approval

**Blocked by:** Tasks 4, 5

Moderator reviews pending entries via `GET /api/moderator/polls/:id/custom-entries` and `PATCH /api/moderator/polls/custom-entries/:id`. Approved entries create PollOptions. `ModeratorPolls.jsx` shows pending entries with Approve/Reject.

**Acceptance criteria:**

- [ ] Moderator sees pending entries badge per poll
- [ ] Approve → PollOption created, voteable by donors
- [ ] Reject → hidden, no option created

### Task 7: Moderator Dashboard & Entity CRUD

**Blocked by:** Task 4

Complete moderator CRUD routes and UI for polls, rewards, goals, claims. New pages: `ModeratorLayout`, `ModeratorDashboard`, `ModeratorPolls`, `ModeratorRewards`, `ModeratorGoals`, `ModeratorClaims`.

**Acceptance criteria:**

- [ ] Moderator can CRUD polls, rewards, goals via UI
- [ ] Moderator can view and fulfill/revert claims
- [ ] Dashboard shows pending entries and stats
- [ ] Moderator cannot access `/api/admin/*`

### Task 8: Integration & Polish

**Blocked by:** Tasks 2, 3, 6, 7

Navbar shows "Moderate" link for moderators. App.jsx adds `/moderate` routes. CLAUDE.md updated. No regressions.

**Acceptance criteria:**

- [ ] Moderator sees "Moderate" in Navbar
- [ ] Non-moderator sees no link
- [ ] All existing flows unchanged
- [ ] CLAUDE.md updated

### Task 9: Prometheus Metrics

**Blocked by:** None

Expose application metrics at `GET /metrics` for Prometheus scraping. Track HTTP request counts/durations, donation volume, donor counts, balance totals, pledge counts, and error rates. Use `express-prom-bundle` or a lightweight manual counter approach.

**Acceptance criteria:**

- [ ] `GET /metrics` returns Prometheus-formatted text at `/api/metrics`
- [ ] Metrics include: HTTP request count + duration (by route + status), donation total + count, active donor count, total balance_remaining, pledge count by status, webhook event count
- [ ] Metrics endpoint is unauthenticated (standard Prometheus pattern) but rate-limited
- [ ] `PROMETHEUS_ENABLED` env var (default `true`) controls whether the endpoint is mounted
- [ ] Docker Compose exposes port for Prometheus scraping (optional sidecar)
- [ ] No new dependencies beyond `prom-client` (Prometheus client library)
- [ ] Tests verify metrics endpoint returns valid Prometheus format

### Task 10: Outbound Webhooks

**Blocked by:** None

Fire configurable outbound webhooks to external URLs when key events occur. Events: `donation.created`, `reward.claimed`, `poll.voted`, `goal.contributed`, `pledge.fulfilled`. Webhook targets are managed via admin CRUD. Each target has a URL, optional secret (HMAC signing), and event type filter. Delivery is fire-and-forget with retry (3 attempts, exponential backoff).

**Acceptance criteria:**

- [ ] New DB model `OutboundWebhook` — `id`, `url`, `secret` (nullable), `event_types` (JSON array), `is_active`, `created_at`
- [ ] New DB model `WebhookDelivery` — `id`, `webhook_id`, `event_type`, `payload` (JSON), `response_status`, `response_body`, `attempts`, `last_attempt_at`, `created_at`
- [ ] Admin CRUD at `/api/admin/outbound-webhooks` — create, list, update, delete, toggle active
- [ ] Admin UI page `AdminOutboundWebhooks.jsx` — table + create/edit modal
- [ ] Shared `fireOutboundWebhooks(eventType, payload)` service — iterates active targets matching event type, POSTs JSON body with optional HMAC-SHA256 `X-Webhook-Signature` header, records delivery
- [ ] Integration points: `processDonation()` fires `donation.created`, `claimRewardTx` fires `reward.claimed`, `votePollTx` fires `poll.voted`, `contributeGoalTx` fires `goal.contributed`, `fulfillPledge` fires `pledge.fulfilled`
- [ ] Retry: 3 attempts with ~5s exponential backoff via `setTimeout` (non-blocking)
- [ ] Admin can view delivery log per webhook (last 50 deliveries)
- [ ] `OUTBOUND_WEBHOOK_TIMEOUT_MS` env var (default `10000`) for HTTP timeout
- [ ] Tests: webhook delivery succeeds, HMAC signing, retry on failure, admin CRUD

### Dependency Graph

```
Task 1 (Foundation)
 ├─ Task 2 (Simulation)
 ├─ Task 3 (Blocked Words)
 │    └─ Task 5 (Custom Entry — Donor)
 │         └─ Task 6 (Custom Entry — Moderator Approval)
 ├─ Task 4 (Moderator Auth)
 │    ├─ Task 6 (Custom Entry — Moderator Approval)
 │    └─ Task 7 (Moderator CRUD UI)
 └─ Task 8 (Integration) ← depends on 2, 3, 6, 7
```

Tasks 2, 3, 4 can run in parallel after Task 1. Task 5 depends on 3. Task 6 depends on 4+5. Task 7 depends on 4. Task 8 is the final pass.

---

## Critical Implementation Details

### 1. Webhook Raw Body (server/index.js)

```js
// MUST mount webhook route BEFORE express.json()
app.use('/api/webhooks/tiltify', express.raw({ type: 'application/json' }), webhookRouter);
app.use(express.json()); // all other routes
```

### 2. Webhook Flow (server/routes/webhook.js)

1. Verify HMAC-SHA256 signature (`crypto.timingSafeEqual`)
2. Parse raw body JSON
3. Filter to `donation.completed` events only (ack all others with 200)
4. Call shared `processDonation()` → upserts donor, creates donation record, sends email

### 3. All Balance Mutations Use Prisma Transactions

```js
await prisma.$transaction([
  prisma.donor.update({ where: { id }, data: { balance_remaining: { decrement: amount } } }),
  prisma.rewardClaim.create({ data: { ... } }),
  prisma.reward.update({ where: { id }, data: { quantity_claimed: { increment: 1 } } }),
]);
```

### 4. Tiltify OAuth2 (server/services/tiltify.js)

- POST to `https://v5api.tiltify.com/oauth/token` with client credentials
- Cache token until ~60s before expiry

### 5. Donor Token Flow (client)

- `MyWallet.jsx` reads `?token=` from URL → stores in `localStorage`
- `api/client.js` interceptor auto-appends `?token=` to all requests

### 6. Moderator Auth

- `MODERATOR_EMAILS` env var (comma-separated)
- Webhook sets `is_moderator: true` on matching emails
- `moderatorAuth.js` = donorAuth + is_moderator check
- Moderator UI uses donor token (no separate API key)

### 7. Blocked Words Validation

- Shared util `checkBlockedWords(text)`: splits by word boundary, lowercases, matches against BlockedWord table
- Whole-word only, case-insensitive

### 8. Custom Entry Flow

- Donor submits → PENDING (no balance deduction)
- Moderator approves → PollOption created, voteable
- Moderator rejects → hidden
- Blocked words checked on submission

---

## Bootstrap Commands

```bash
cd /home/bongo/projects/esa/dono-ui
npm install
cp .env.example .env   # fill in values
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..
npm run dev            # starts server on :3001, client on :5173
```

## Local Webhook Testing

```bash
ngrok http 3001
# Register https://<ngrok-url>/api/webhooks/tiltify in Tiltify dashboard
# Set TILTIFY_WEBHOOK_SECRET to the generated secret

# Or test locally without HMAC (leave TILTIFY_WEBHOOK_SECRET unset):
curl -X POST http://localhost:3001/api/webhooks/tiltify \
  -H "Content-Type: application/json" \
  -d '{"meta":{"event_type":"donation.completed"},"data":{"id":"test-123","donor_email":"test@example.com","donor_name":"Test","amount":{"value":"10.00"},"comment":"test"}}'

# Simulate via admin UI: visit /admin/add-donation (route #238)
```
