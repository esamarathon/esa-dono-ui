# Dono-UI — ESA Charity Donation Platform

A donation platform for ESA charity events integrating with Tiltify for payment processing. Donors receive events via webhook, get credited balances, and spend them on rewards, polls, and pooled fund goals. No user accounts — donors are identified by email and access their wallet via a magic link token emailed after each donation.

## Prerequisites

- **Node.js** 22+
- **npm** 10+
- **Tiltify account** with a campaign and OAuth credentials
- **SMTP provider** (optional — without SMTP, magic links are logged to stdout)

## Local Development

```bash
# Clone and install
git clone https://github.com/Codescales/esa-dono-ui.git
cd esa-dono-ui
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Tiltify credentials and other values

# Initialize the database
cd server && npx prisma migrate dev --name init && npx prisma generate && cd ..

# Start (server on :3001, client on :5173)
npm run dev
```

### Running Tests

```bash
npm test                    # all workspace tests
npm run test --workspace server   # server only
npm run test --workspace client   # client only
npm run test:ci             # CI mode (junit reporter)
```

## Environment Variables

| Variable                   | Required   | Default                                    | Description                                                                                           |
| -------------------------- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `TILTIFY_CLIENT_ID`        | Yes        | —                                          | Tiltify OAuth2 client ID                                                                              |
| `TILTIFY_CLIENT_SECRET`    | Yes        | —                                          | Tiltify OAuth2 client secret                                                                          |
| `TILTIFY_CAMPAIGN_ID`      | Yes        | —                                          | Tiltify campaign ID to proxy                                                                          |
| `TILTIFY_DONATE_URL`       | No         | —                                          | Static Tiltify donate page URL (fallback when relay not configured)                                   |
| `TILTIFY_DONATE_ID`        | No         | —                                          | Campaign identifier in the donate URL (UUID or `@username/slug`)                                      |
| `TILTIFY_WEBHOOK_RELAY_ID` | No         | —                                          | Webhook Relay ID from Tiltify Developer Dashboard                                                     |
| `TILTIFY_WEBHOOK_SECRET`   | No         | —                                          | HMAC secret for webhook verification (omit to skip verification during dev)                           |
| `ADMIN_API_KEY`            | Yes (prod) | —                                          | Admin API key passed as `X-Admin-Key` header                                                          |
| `MODERATOR_API_KEY`        | No         | —                                          | Operational fallback key passed as `X-Moderator-Key` for moderator routes, independent of donor roles |
| `ADMIN_EMAILS`             | No         | —                                          | Comma-separated emails granted the ADMIN role at request time (not on donation)                       |
| `MODERATOR_EMAILS`         | No         | —                                          | Comma-separated emails granted the MODERATOR role at request time (not on donation)                   |
| `SMTP_HOST`                | No         | —                                          | SMTP server hostname (omit to log magic links to stdout instead)                                      |
| `SMTP_PORT`                | No         | `587`                                      | SMTP server port                                                                                      |
| `SMTP_SECURE`              | No         | `false`                                    | Use TLS (set `true` for port 465)                                                                     |
| `SMTP_USER`                | No         | —                                          | SMTP authentication username                                                                          |
| `SMTP_PASS`                | No         | —                                          | SMTP authentication password                                                                          |
| `EMAIL_FROM`               | No         | `Donation Platform <no-reply@example.com>` | From address for magic link emails                                                                    |
| `APP_BASE_URL`             | No         | `http://localhost:5173`                    | Base URL for magic links in emails                                                                    |
| `PORT`                     | No         | `3001`                                     | Server listen port                                                                                    |
| `DATABASE_URL`             | No         | `file:./dev.db`                            | Prisma database URL (SQLite)                                                                          |
| `RATE_LIMIT_SPEND`         | No         | `20`                                       | Max spend requests per minute per donor                                                               |

## Tiltify Webhook Registration

1. **Expose your server**: Use a reverse proxy or tunnel tool like [ngrok](https://ngrok.com):

   ```bash
   ngrok http 3001
   ```

2. **Register in Tiltify**: In the Tiltify Developer Dashboard, register a webhook endpoint:

   - **URL**: `https://<your-ngrok-url>/api/webhooks/tiltify`
   - **Events**: Select `donation.completed`

3. **Set the secret**: Copy the generated webhook secret and set it in `.env`:

   ```
   TILTIFY_WEBHOOK_SECRET=<your-generated-secret>
   ```

4. **Optional — Webhook Relay**: For deterministic donation→pledge linkage, create a Webhook Relay in the Tiltify Developer Dashboard and set `TILTIFY_WEBHOOK_RELAY_ID` to its ID.

During local development you can leave `TILTIFY_WEBHOOK_SECRET` unset to skip HMAC signature verification.

## Production Deployment

The project uses a **two-container** architecture: a Node.js Express API (`Dockerfile.backend`) and an nginx SPA server (`Dockerfile.frontend`).

### Container Architecture

- **Backend** (`Dockerfile.backend`): Multi-stage build (`base` → `deps` → `runtime`). Runs as non-root user `dono` (UID 1001). Applies Prisma migrations on startup via `docker-entrypoint.backend.sh`. Exposes port 3001. SQLite database lives on volume mount `/data`.
- **Frontend** (`Dockerfile.frontend`): Multi-stage build (`builder` → `runner`). Builds the Vite SPA, serves via `nginx-unprivileged` on port 8080, proxies `/api/` to the backend. Runs as non-root `nginx` user.

Both images include `HEALTHCHECK` instructions. The backend checks `GET /api/health`, the frontend checks `GET /`.

### Building and Running with Docker Compose

```bash
# Build and start the full stack
ADMIN_API_KEY=change-me docker compose up --build

# Frontend available at http://localhost:8080 (proxies /api to backend)
# SQLite data persisted in the dono-data volume
```

For production, set all environment variables via a `.env` file or shell environment:

```bash
# Create a production .env file
cat > .env.production << 'EOF'
TILTIFY_CLIENT_ID=your_client_id
TILTIFY_CLIENT_SECRET=your_client_secret
TILTIFY_CAMPAIGN_ID=your_campaign_id
TILTIFY_DONATE_URL=https://donate.tiltify.com/your-campaign
TILTIFY_DONATE_ID=your-donate-id
TILTIFY_WEBHOOK_RELAY_ID=your_relay_id
TILTIFY_WEBHOOK_SECRET=your_webhook_secret
ADMIN_API_KEY=your-secure-admin-key
MODERATOR_API_KEY=your-secure-moderator-key
ADMIN_EMAILS=owner@example.com
MODERATOR_EMAILS=mod1@example.com,mod2@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
EMAIL_FROM="Donation Platform <donations@example.com>"
APP_BASE_URL=https://donations.example.com
RATE_LIMIT_SPEND=20
EOF

# Start with the env file
docker compose --env-file .env.production up -d
```

### Manual Container Build

```bash
# Backend
docker build -f Dockerfile.backend --target runtime -t esa-dono-ui/backend:latest .

# Frontend
docker build -f Dockerfile.frontend -t esa-dono-ui/frontend:latest .
```

### Smoke Test

Verify the stack is functional:

```bash
ADMIN_API_KEY=change-me FRONTEND_PORT=18080 ./scripts/smoke-test.sh
```

The smoke test validates: backend health through nginx proxy, SPA index serving, client-side route fallback, admin auth enforcement, end-to-end donation simulation (proves migrations + DB writes), and volume persistence across a backend restart.

### Reverse Proxy Configuration

For deployments using an external reverse proxy (nginx, Caddy, etc.) instead of the frontend container:

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name donations.example.com;

    # Backend API (Dockerfile.backend exposes port 3001)
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 2m;
    }

    # Frontend SPA (served from dist/ or a frontend container on :8080)
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

**Caddy:**

```
donations.example.com {
    reverse_proxy /api/* 127.0.0.1:3001
    reverse_proxy /* 127.0.0.1:8080
}
```

### Key Deployment Notes

- **Volume mount**: In production, mount a persistent volume at `/data` in the backend container. The `docker-compose.yml` does this via the `dono-data` named volume.
- **No secrets baked in**: Config is injected via environment variables at runtime. No defaults for secrets exist in the images.
- **Non-root**: Both containers run as non-root users.
- **Migrations**: The backend entrypoint runs `prisma migrate deploy` on every startup, making it safe to update images without manual DB intervention.

## Database Management

### Migrations

```bash
# Development: create a new migration
cd server && npx prisma migrate dev --name <name>

# Production: apply pending migrations (handled by entrypoint on container start)
cd server && npx prisma migrate deploy

# Browse data
cd server && npx prisma studio
```

### Backup

SQLite databases are single-file — backup is a file copy. **Stop or pause writes before backing up** to avoid corruption:

```bash
# Option 1: Stop server, copy the file
docker compose stop dono-backend
cp /path/to/volume/dono.db dono-backup-$(date +%Y%m%d).db
docker compose start dono-backend

# Option 2: sqlite3 .backup (online, atomic)
sqlite3 /path/to/volume/dono.db ".backup 'dono-backup-$(date +%Y%m%d).db'"
```

For the Docker Compose setup, the DB lives at `/data/dono.db` inside the backend container. Copy it out with:

```bash
docker compose cp dono-backend:/data/dono.db ./dono-backup.db
```

## Simulating Donations

Three methods for testing without real money:

### Option A — Admin UI

Visit `/admin/simulate`, fill in donor email + amount, click "Simulate Donation". Copy the generated magic link to access the donor wallet.

### Option B — curl (direct webhook POST)

When `TILTIFY_WEBHOOK_SECRET` is unset, HMAC verification is skipped:

```bash
curl -X POST http://localhost:3001/api/webhooks/tiltify \
  -H "Content-Type: application/json" \
  -d '{"meta":{"event_type":"donation.completed"},"data":{"id":"test-123","donor_email":"test@example.com","donor_name":"Test","amount":{"value":"10.00"},"comment":"test"}}'
```

### Option C — Admin API

```bash
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: change-me" \
  -d '{"email":"test@example.com","amount_cents":1000}'
```

Returns `{ success: true, token, donor }`. Build a magic link: `http://localhost:5173/wallet?token=<token>`.

## Architecture

```
client/           React 18 + Vite + Tailwind SPA
server/           Express 4 API (ESM, tsx)
packages/shared/  Cross-cutting types (@dono/shared)
```

- **Database**: SQLite via Prisma. All monetary values are integer cents.
- **Tiltify integration**: OAuth2 client-credentials token with in-memory cache. Campaigns proxied from Tiltify v5 API.
- **Webhook flow**: HMAC-SHA256 verification → `processDonation()` (upserts donor, credits balance, sends magic link, auto-fulfills pledges).
- **Pledge/Cart system**: Donors select incentives before donating. Pledge resolves by relay key or email fallback.
- **Moderator/admin access**: Donors have a `role` (`USER`/`MODERATOR`/`ADMIN`) resolved on every authenticated request from the `ADMIN_EMAILS`/`MODERATOR_EMAILS` allowlists (never granted as a side effect of donating — see `server/lib/roles.ts`). `MODERATOR_API_KEY`/`ADMIN_API_KEY` provide operational fallback access to moderator routes independent of donor roles.

## Troubleshooting

### SMTP not working / magic links not received

- Without `SMTP_HOST` set, magic links are **logged to stdout** instead of emailed. Check server logs.
- Verify SMTP credentials: `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_SECURE`.
- Common SMTP issues: port 587 requires `SMTP_SECURE=false` (STARTTLS), port 465 requires `SMTP_SECURE=true` (TLS).
- Check `EMAIL_FROM` is a valid address for your SMTP provider.
- Ensure `APP_BASE_URL` is set correctly — it's used to build the magic link URL in emails.

### HMAC signature verification failure (HTTP 401 on webhook)

- If the signature doesn't match, the webhook returns 401. Check that `TILTIFY_WEBHOOK_SECRET` matches the secret in the Tiltify Developer Dashboard.
- During local development, you can leave `TILTIFY_WEBHOOK_SECRET` unset to skip verification.
- The webhook route must be mounted **before** `express.json()` — this is handled correctly in `server/index.ts` but note it if modifying middleware order.

### Magic link token expired / login fails

- Donor tokens have a TTL (set in `processDonation`). If expired, the donor needs a new donation to receive a fresh token.
- Check `DATABASE_URL` points to the correct database file. The token is stored in the `Donor.magic_token` column.
- If using containers, ensure the `/data` volume is mounted and persistent. A new container without the volume will have an empty database with no donor records.

### Database locked / busy errors (SQLite)

- SQLite handles concurrent reads but serializes writes. Under high write load, you may see `SQLITE_BUSY` errors.
- The app uses Prisma transactions for all balance mutations to keep writes atomic.
- For production at scale, consider migrating to PostgreSQL (change `datasource.provider` and `DATABASE_URL`).
