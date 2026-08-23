# Dono-UI — ESA Charity Donation Platform

A donation platform for ESA charity events integrating with Tiltify for payment processing. Donors receive events via webhook, get credited balances, and spend them on rewards, polls, and pooled fund goals. No user accounts — donors are identified by email and access their wallet via a magic link token emailed after each donation.

## Prerequisites

- **Node.js** 22+
- **npm** 10+
- **Tiltify account** with a campaign and OAuth credentials
- **SMTP provider** (optional — without SMTP, magic links are logged to stdout)

## Documentation

| Topic                                         | Guide                                                          |
| --------------------------------------------- | -------------------------------------------------------------- |
| Local development & tests                     | [docs/local-development.md](docs/local-development.md)         |
| Environment variables                         | [docs/environment-variables.md](docs/environment-variables.md) |
| Webhooks & metrics (Prometheus)               | [docs/webhooks-and-metrics.md](docs/webhooks-and-metrics.md)   |
| Outbound event delivery (webhooks & RabbitMQ) | [docs/outbound-events.md](docs/outbound-events.md)             |
| Production deployment (Docker)                | [docs/deployment.md](docs/deployment.md)                       |
| Database management                           | [docs/database.md](docs/database.md)                           |
| Simulating donations                          | [docs/simulating-donations.md](docs/simulating-donations.md)   |
| Troubleshooting                               | [docs/troubleshooting.md](docs/troubleshooting.md)             |

## Quick Start

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
- **Metrics**: `GET /api/metrics` (Prometheus format) gated by `METRICS_API_KEY` — see [Webhooks & Metrics](docs/webhooks-and-metrics.md).
- **Outbound event delivery**: admin-configured destinations (HTTP or RabbitMQ) receive donation/incentive events via a persistent, per-destination FIFO outbox with retry/backoff — see [Outbound Event Delivery](docs/outbound-events.md).
