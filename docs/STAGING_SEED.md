# Running the Dev Seed on Staging (oci-public)

This guide explains how to run the Prisma seed script on the staging server to create persistent dev accounts and the banner with API keys.

## Overview

The seed script (`server/prisma/seed.ts`) creates:

- ✅ Moderator account at `moderator@localhost`
- ✅ Admin account at `admin@localhost`
- ✅ Broadcast banner displaying current API keys from env vars

These accounts and the banner persist across database restarts, including staging's daily resets.

## Prerequisites

- SSH access to the oci-public staging server
- Docker running on the staging server
- The staging container must be running (from the latest `dev` branch images)

## Option 1: Remote SSH + Docker Exec (Recommended)

This is the safest approach - run the seed without needing to modify deployment configs.

### Steps:

1. SSH into the staging server:

```bash
ssh oci-public
```

2. Navigate to the deployment directory:

```bash
cd /home/ubuntu/projects/esa-dono-ui
```

3. Run the seed in the running backend container. The runtime image has
   **no npm/npx** (stripped from the image), so invoke `tsx` directly rather
   than going through `prisma db seed` (whose seed runner shells out to `tsx`
   via `$PATH`, which isn't set up in an exec session):

```bash
docker exec -w /app/server esa-dono-ui-dono-backend-1 sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'
```

4. Verify the seed completed successfully - you should see:

```
🌱 Starting seed...
✓ Moderator account: moderator@localhost (ID: ...)
✓ Admin account: admin@localhost (ID: ...)
✓ Banner created/updated with moderator and admin keys
✅ Seed completed successfully!
```

## Option 2: Using the Helper Script

The helper script wraps the same `docker exec` call:

```bash
ssh oci-public
cd /home/ubuntu/projects/esa-dono-ui
./scripts/run-seed-staging.sh esa-dono-ui-dono-backend-1
```

(The script only lives in the repo checkout, not on the deployed server unless
it's been copied there — it's a thin wrapper, so running the `docker exec`
command directly, as in Option 1, works the same.)

## Option 3: Manual Container Access

1. SSH into staging
2. Get a shell in the running container:

```bash
docker exec -it -w /app/server esa-dono-ui-dono-backend-1 sh
```

3. Inside the container, run:

```bash
/app/node_modules/.bin/tsx prisma/seed.ts
```

4. Exit the container:

```bash
exit
```

## Verification

After running the seed, verify the accounts were created by:

1. Visiting the staging app at `https://donate.codescales.xyz`
2. Checking the banner API directly:

   ```bash
   curl -s https://donate.codescales.xyz/api/campaign/broadcast
   ```

   Should return the current `key_mod_...` / `key_admin_...` values from staging's `.env`

3. Optionally, test login via moderator key in `/moderate` page

## If the Seed Fails

### Error: "npx: executable file not found in $PATH"

The runtime image strips npm to stay slim — there is no `npx`/`npm` inside it.
Use the binary directly:

```bash
docker exec -w /app/server esa-dono-ui-dono-backend-1 sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'
```

### Error: "spawn tsx ENOENT" (via `prisma db seed`)

`node_modules/.bin` isn't on `$PATH` in an exec session, so Prisma's seed
runner (which shells out to plain `tsx`) can't find it. Skip the Prisma CLI
wrapper and invoke tsx directly, as above.

### Error: "No such file or directory: server/prisma/seed.ts"

Make sure the backend image was built from the latest commit (4d54458 or later with the seed feature). Pull the latest dev image:

```bash
docker compose pull
docker compose up -d
```

Then run the seed again.

### Error: Database locked

Wait a moment and retry - the database might be in use by background tasks.

## Seed Details

**Accounts created:**

- Email: `moderator@localhost` | Role: MODERATOR | email_verified: true
- Email: `admin@localhost` | Role: ADMIN | email_verified: true

**Environment variables read:**

- `MODERATOR_API_KEY` from docker-compose/.env (default: `dev-moderator-key`)
- `ADMIN_API_KEY` from docker-compose/.env (default: `change-me`)

**API Keys shown in banner:**

- Moderator: `key_mod_{MODERATOR_API_KEY}`
- Admin: `key_admin_{ADMIN_API_KEY}`

## Daily Staging Resets

Since the seed uses database operations (not filesystem), the accounts and banner automatically survive the daily staging reset cycle:

1. Database is reset/cleared
2. Migrations run (via docker-entrypoint)
3. Simply re-run the seed script after reset to recreate the dev accounts and banner

## Integration into Staging Deployment

If you want to make the seed run automatically on staging startup, modify
`docker-entrypoint.backend.sh` to invoke tsx directly (no npx available in
the runtime image):

```bash
# After migrations
(cd server && /app/node_modules/.bin/tsx prisma/seed.ts) || true
```

Then rebuild the backend image. This way the seed runs every time the
container starts.

---

**Last updated:** 2026-09-10 (verified against a live run on oci-public;
deployment migrated from `ghcr.io/codescales/esa-dono-ui/*` to
`ghcr.io/esamarathon/esa-dono-ui/*` as the canonical registry namespace)
**Feature commit:** 4d54458 (dev seed implementation)
