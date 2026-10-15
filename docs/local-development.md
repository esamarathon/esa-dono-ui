# Local Development

## Setup

```bash
# Clone and install
git clone https://github.com/Codescales/esa-dono-ui.git
cd esa-dono-ui
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Stripe credentials and other values

# Initialize the database
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..
cd server && npx prisma db seed && cd ..   # dev moderator/admin accounts + banner (see Dev Seed)

# Start (server on :3001, client on :5173)
npm run dev
```

## Running Tests

```bash
npm test                    # all workspace tests
npm run test --workspace server   # server only
npm run test --workspace client   # client only
npm run test --workspace @dono/shared  # pure pledge planner worked examples
npm run test:ci             # CI mode (junit reporter)
```

## Dev Seed

The seed script creates:

- **Moderator account** (`moderator@localhost`) with role `MODERATOR`
- **Admin account** (`admin@localhost`) with role `ADMIN`
- **Banner** at the top of the app displaying the moderator and admin API keys
- One active Event and an active primary Channel. Newly created Default goal lists
  are empty; re-seeding does not overwrite an operator's ordered list.

Seed/admin-added donations without a pledge keep legacy Wallet credit. New pooled
pledges must use `pledge_amount_cents`, a stable `draft_id`, the exact client-shown
`@dono/shared` `planPledge` result and an active `channel_id`. Wallet-only pooled
pledges add no money and pooled fulfillment creates no Wallet credit. To choose
fallbacks, update `/api/admin/channels/:id` (or the moderator equivalent) with
`default_goals: [goalId, …]`: own/shared ids only, in order; inactive/completed entries
are preserved. See `docs/simulating-donations.md` for the simulator's real API boundaries.
The amount-first donate UI and backend ship together. The coordinated parent callers
and cold cross-Channel Kollekt dependency are described in `docs/api-consumers.md`;
local tests or seeding do not establish the runtime release gates in `docs/deployment.md`.

The banner uses the keys from `MODERATOR_API_KEY` and `ADMIN_API_KEY` env vars (seed defaults:
raw `dev-moderator-key` and `dev-admin-key`; configure matching backend keys explicitly).
The accounts and banner survive restarts and are preserved on staging through daily
resets — the banner always displays
the current API keys from the `.env` file.

To re-run the seed (e.g., after clearing the DB or updating env keys):

```bash
cd server && npx prisma db seed
```
