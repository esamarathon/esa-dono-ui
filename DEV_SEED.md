# Dev Seed Implementation Summary

## What was implemented

Added a Prisma seed script that creates persistent dev accounts and a banner displaying the moderator/admin API keys.

### Files Created

**`server/prisma/seed.ts`** - Prisma seed script that:

1. Creates a `MODERATOR` role account at `moderator@localhost` (persistent across restarts)
2. Creates an `ADMIN` role account at `admin@localhost` (persistent across restarts)
3. Creates/updates a broadcast banner that displays both API keys with:
   - Level: `INFO` (blue styling)
   - Message format: `🔑 Moderator login: go to /moderate and paste this key: <KEY> | Admin login: go to /admin and paste this key: <KEY>`
     (raw key, not prefixed — the login forms add `key_mod_`/`key_admin_` themselves before sending the Bearer credential)

The script reads `MODERATOR_API_KEY` and `ADMIN_API_KEY` from environment variables (.env file).

### Files Modified

**`server/package.json`**

- Added `"prisma": { "seed": "tsx prisma/seed.ts" }` configuration to enable seed support

**`CLAUDE.md`**

- Added `cd server && npx prisma db seed` to the Commands section
- Added new "Dev Seed" section documenting:
  - What accounts are created
  - That they survive restarts and staging daily resets
  - How to re-run the seed

## How it works

### Running the seed

From the root directory:

```bash
cd server && npx prisma db seed
```

This creates or updates:

- Dev moderator/admin donor accounts with `email_verified: true` (so they can use the allowlist system)
- A broadcast banner showing the current API keys from .env

### On every restart

The accounts and banner **persist** in the database because they use `upsert()` operations:

- If accounts exist, they're updated (role is confirmed as MODERATOR/ADMIN)
- If the banner exists, it's updated (keys are refreshed to match current .env values)
- If either doesn't exist, they're created

### Environment variable handling

The seed reads `MODERATOR_API_KEY` and `ADMIN_API_KEY` from the `.env` file:

```env
ADMIN_API_KEY=change-me
MODERATOR_API_KEY=dev-moderator-key
```

The banner message dynamically includes these values, so changing `.env` and re-running the seed updates the displayed keys.

### On staging with daily resets

Since the seed uses database operations (not filesystem/config), the accounts and banner survive daily database resets — they're recreated by Prisma migrations. To ensure they appear after a reset, run:

```bash
cd server && npx prisma db seed
```

This should be part of the staging deployment workflow.

## Banner display

The banner is displayed at the top of the app via the existing `BroadcastBanner` component in React:

- Fetches from `GET /api/campaign/broadcast`
- Displays at app root level (in `client/src/App.tsx`)
- Styled with `INFO` level styling (blue gradient, subtle border)
- Shows on every page load, providing always-visible access to the dev API keys

## Default values

If env vars are not set:

- `MODERATOR_API_KEY` defaults to `dev-moderator-key`
- `ADMIN_API_KEY` defaults to `change-me`

These map to full keys like `key_mod_dev-moderator-key` and `key_admin_change-me` in the banner.

## Idempotency

The seed is idempotent — running it multiple times is safe:

1. Donor accounts use email as upsert key, so repeated runs update existing accounts
2. Banner uses `findFirst()` + update/create logic, so it safely updates the existing banner

## Bootstrap workflow

Updated `CLAUDE.md` Bootstrap section now includes:

```bash
cp .env.example .env   # fill in values
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..
cd server && npx prisma db seed  # creates dev moderator/admin accounts + banner
cd ..
npm run dev
```
