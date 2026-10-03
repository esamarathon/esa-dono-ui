# ESA End-to-End Testing Quick Reference

This directory preserves the Docker Compose configuration, setup script, and guides for later end-to-end testing of the ESA donation platform stack.

Run the commands below from the repository root. Build contexts in the Compose file are relative to `tests/e2e/`; the setup script finds the repository root automatically.

> **Setup draft:** The optional Kollekt and overlay configurations are unverified. The database commands in this draft target the host development database, not the container volume. Review the configuration before running it; it is not an automated E2E assertion suite.

## Files

- **`tests/e2e/docker-compose.e2e.yml`** — Docker Compose configuration that includes:
  - esa-dono-ui backend & frontend
  - RabbitMQ message broker
  - Kollekt (optional, via `--profile with-kollekt`)
  - esa-layouts-v2 overlay (optional, via `--profile with-overlay`)

- **`tests/e2e/setup-e2e.sh`** — Automated setup script that:
  - Clones required repositories (Kollekt, esa-layouts-v2)
  - Builds Docker images
  - Starts services
  - Initializes the database
  - Seeds test data

- **`tests/e2e/docs/e2e-testing.md`** — Comprehensive testing guide with:
  - Detailed setup instructions
  - Test scenarios (donation flow, API integration, message flow)
  - Troubleshooting guide
  - Environment variable reference

## Quick Start (30 seconds)

### Option A: Automated Setup

```bash
# From esa-dono-ui directory
# Start core stack only (backend + frontend + RabbitMQ)
./tests/e2e/setup-e2e.sh

# Start with all services (Kollekt + Overlay)
./tests/e2e/setup-e2e.sh --all
```

### Option B: Manual Setup

```bash
# Copy and edit environment file
cp .env.example .env
# Edit .env: set ADMIN_API_KEY, KOLLEKT_BUILD_CONTEXT, OVERLAY_BUILD_CONTEXT

# Clone dependencies
git clone https://github.com/esamarathon/kollekt.git ../kollekt
git clone https://github.com/esamarathon/esa-layouts-v2.git ../esa-layouts-v2

# Start services (all profiles)
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml \
  --profile with-kollekt \
  --profile with-overlay \
  up -d

# Initialize database
cd server && npx prisma migrate dev && npx prisma db seed && cd ..
```

## Access Points

| Service             | URL                            | Credentials                                     |
| ------------------- | ------------------------------ | ----------------------------------------------- |
| Frontend            | http://localhost:8080          | —                                               |
| Admin UI            | http://localhost:8080/admin    | `key_admin_change-me` (or your `ADMIN_API_KEY`) |
| Moderator UI        | http://localhost:8080/moderate | Same as Admin                                   |
| Backend API         | http://localhost:3001/api      | Admin key required for some endpoints           |
| RabbitMQ Management | http://localhost:15672         | guest / guest                                   |
| Overlay             | http://localhost:3002          | —                                               |

## Common Commands

```bash
# Start/stop services
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml up -d
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml down

# Start with specific services
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml up -d                    # Core only
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-kollekt up -d
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-overlay up -d
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-kollekt --profile with-overlay up -d

# View logs
docker logs -f esa-dono-backend
docker logs -f esa-rabbitmq
docker logs -f esa-kollekt
docker logs -f esa-layouts-v2

# Access database
cd server && npx prisma studio

# Rebuild images
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml build --no-cache

# Clean everything
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml down -v
```

## Testing Workflow

1. **Create a test donation** via http://localhost:8080/admin/simulate
2. **Configure RabbitMQ destination** at http://localhost:8080/admin/destinations
   - URL: `amqp://guest:guest@rabbitmq:5672`
   - Event: `donation.created`
3. **Create another donation** to trigger publishing
4. **Check RabbitMQ logs** to see messages published
5. **Check Kollekt logs** to see messages consumed:
   ```bash
   docker logs -f esa-kollekt
   ```
6. **Check Overlay** (if running) to see donation displayed

## Environment File (.env)

Key variables for e2e testing:

```bash
# Required
ADMIN_API_KEY=key_admin_change-me

# For Kollekt/Overlay support
KOLLEKT_BUILD_CONTEXT=../../../kollekt
OVERLAY_BUILD_CONTEXT=../../../esa-layouts-v2

# Service configuration
API_BASE_URL=http://dono-backend:3001/api
APP_BASE_URL=http://localhost:8080

# Optional (gracefully disabled if empty)
STRIPE_SECRET_KEY=
GOOGLE_CLIENT_ID=
DISCORD_CLIENT_ID=
SMTP_HOST=
```

See `tests/e2e/docs/e2e-testing.md` for complete environment variable reference.

## Troubleshooting

**Services won't start?**

- Check logs: `docker logs -f <service-name>`
- Ensure ports 3001, 5672, 8080, 15672 are available

**RabbitMQ connection failed?**

- Wait for RabbitMQ to start (takes ~10s after docker compose up)
- Check RabbitMQ management UI at http://localhost:15672

**Database migration errors?**

- Reset: `cd server && npx prisma migrate reset`
- Re-seed: `npx prisma db seed`

**Kollekt not consuming messages?**

- Verify RabbitMQ is running: `docker ps | grep rabbitmq`
- Check logs: `docker logs -f esa-kollekt`
- Verify message format matches ADR-0009 spec

See `tests/e2e/docs/e2e-testing.md` for more detailed troubleshooting.

## Documentation

- **Full Setup Guide:** `tests/e2e/docs/e2e-testing.md`
- **Message Format (Tiltify-compatible):** `docs/adr/0009-tiltify-compatible-messages.md`
- **REST API (Tiltify-compatible):** `docs/adr/0010-tiltify-compatible-rest-api.md`
- **Webhook Delivery & Outbound Events:** `docs/adr/0005-outbound-webhooks.md`
- **Deployment Guide:** `docs/deployment.md`

## Repository Links

- **esa-dono-ui:** https://github.com/esamarathon/esa-dono-ui
- **Kollekt:** https://github.com/esamarathon/kollekt
- **esa-layouts-v2:** https://github.com/esamarathon/esa-layouts-v2
