# Running Seed on OCI-Public Staging Server

## Quick Instructions

To run the dev seed script on the oci-public staging server and create persistent dev accounts + banner:

### Prerequisites

- SSH access to the oci-public server (host alias `oci-public`)
- Docker compose deployed and running on staging
- Images pulled from `ghcr.io/esamarathon/esa-dono-ui` (the canonical org — do **not** use `ghcr.io/codescales/esa-dono-ui`)

### Execute on Staging Server

```bash
# SSH into staging
ssh oci-public

# Deployment directory
cd /home/ubuntu/projects/esa-dono-ui

# Pull latest images and recreate containers
docker compose pull
docker compose up -d

# Run the seed — the runtime image has no npm/npx (stripped to save space),
# so invoke tsx directly against the seed script from server/'s working dir,
# where server/package.json's "prisma.seed" config and relative imports resolve.
docker exec -w /app/server esa-dono-ui-dono-backend-1 sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'

# Expected output:
# 🌱 Starting seed...
# ✓ Moderator account: moderator@localhost (ID: ...)
# ✓ Admin account: admin@localhost (ID: ...)
# ✓ Banner created/updated with moderator and admin keys
# ✅ Seed completed successfully!
```

## What Gets Created

**Accounts:**

- `moderator@localhost` (role: MODERATOR, email_verified: true)
- `admin@localhost` (role: ADMIN, email_verified: true)

**Banner:**

- Displayed at top of app showing moderator and admin API keys
- Message: `🔑 Moderator login: go to /moderate and paste this key: <KEY> | Admin login: go to /admin and paste this key: <KEY>`
  (the raw key, not prefixed — the /moderate and /admin login forms add `key_mod_`/`key_admin_` themselves)
- Uses keys from MODERATOR_API_KEY and ADMIN_API_KEY env vars set in staging's `.env`

## Persistence

✅ Accounts and banner survive:

- Container restarts
- Container recreation (`docker compose up -d` after a pull)
- Staging daily reset cycle (as long as the `dono-data` volume itself isn't wiped —
  re-run the seed if it is)

## Verification

1. Visit the staging app: **https://donate.codescales.xyz**
2. Check the banner directly: `curl -s https://donate.codescales.xyz/api/campaign/broadcast`
3. Test moderator login at `/moderate` with the `key_mod_...` key from the banner
4. Test admin login at `/admin` with the `key_admin_...` key from the banner

## Container/Image Notes

- Container names: `esa-dono-ui-dono-backend-1`, `esa-dono-ui-dono-frontend-1`
- Compose file lives at `/home/ubuntu/projects/esa-dono-ui/docker-compose.yml`
- Images: `ghcr.io/esamarathon/esa-dono-ui/backend:dev`, `ghcr.io/esamarathon/esa-dono-ui/frontend:dev`
  (as of 2026-09-10, updated from the previously-deployed `ghcr.io/codescales/esa-dono-ui/*` images —
  `esamarathon` is now the canonical registry namespace)
- The runtime image has **no npm/npx** — use `/app/node_modules/.bin/tsx` or
  `/app/node_modules/.bin/prisma` directly

## Troubleshooting

### "npx: executable file not found in $PATH"

The runtime image strips npm to keep it slim. Use the binary directly instead:

```bash
docker exec -w /app/server esa-dono-ui-dono-backend-1 sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'
```

### "spawn tsx ENOENT" (when using `prisma db seed`)

`node_modules/.bin` isn't on `$PATH` in the exec session, so Prisma's seed
runner (which just shells out to `tsx prisma/seed.ts`) can't find `tsx`. Skip
the Prisma CLI wrapper and invoke tsx directly as shown above.

### "No such file or directory: server/prisma/seed.ts"

The running container predates the seed feature commit. Pull the latest
`:dev` image and recreate:

```bash
docker compose pull
docker compose up -d
```

### Database locked

Wait a moment and retry — the database might be in use by background tasks.

---

**Last updated:** 2026-09-10 (verified against a live run on oci-public)
**Feature commit:** 4d54458 (dev seed implementation)
