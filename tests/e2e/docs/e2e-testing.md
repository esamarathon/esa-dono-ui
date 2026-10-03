# End-to-End Testing with esa-dono-ui, Kollekt, and esa-layouts-v2

This guide walks you through setting up a complete end-to-end testing environment that integrates:

- **esa-dono-ui** — Donation platform (backend + frontend)
- **Kollekt** — .NET donation event reader
- **esa-layouts-v2** — Stream overlay consumer
- **RabbitMQ** — Message broker for event delivery

## Quick Start

### 1. Clone the Required Repositories

```bash
cd /var/lib/ai-workspace/projects/esa

# Clone Kollekt (if not already present)
git clone https://github.com/esamarathon/kollekt.git

# Clone esa-layouts-v2 (if not already present)
git clone https://github.com/esamarathon/esa-layouts-v2.git

# You should now have:
# - esa-dono-ui/
# - kollekt/
# - esa-layouts-v2/
```

### 2. Create Environment File

Copy the existing `.env.example` in esa-dono-ui and add these additional variables for the e2e setup:

```bash
cd esa-dono-ui
cp .env.example .env
```

**Add/modify these values in `.env`:**

```bash
# Core API (required)
ADMIN_API_KEY=key_admin_change-me

# RabbitMQ (for Kollekt and Overlay)
RABBITMQ_USER=guest
RABBITMQ_PASS=guest
RABBITMQ_HOST=rabbitmq
RABBITMQ_PORT=5672

# Service URLs
APP_BASE_URL=http://localhost:8080
API_BASE_URL=http://dono-backend:3001/api

# Kollekt service
KOLLEKT_BUILD_CONTEXT=../../../kollekt
KOLLEKT_DOCKERFILE=Dockerfile
KOLLEKT_TAG=latest
KOLLEKT_LOG_LEVEL=Information

# Overlay service
OVERLAY_BUILD_CONTEXT=../../../esa-layouts-v2
OVERLAY_DOCKERFILE=Dockerfile
OVERLAY_TAG=latest
OVERLAY_LOG_LEVEL=info

# Service Ports
BACKEND_PORT=3001
FRONTEND_PORT=8080
OVERLAY_PORT=3002
RABBITMQ_PORT=5672
RABBITMQ_MGMT_PORT=15672
```

### 3. Start the Full Stack

```bash
# From esa-dono-ui directory
# Start all services except Kollekt and Overlay
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml up -d

# Start with all services (requires KOLLEKT_BUILD_CONTEXT and OVERLAY_BUILD_CONTEXT set)
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-kollekt --profile with-overlay up -d
```

### 4. Initialize the Database

```bash
# Run migrations and seed dev data
cd server
npx prisma migrate dev
npx prisma db seed
cd ..
```

### 5. Access the Services

- **Frontend (Donation UI):** http://localhost:8080
- **Backend API:** http://localhost:3001/api
- **Admin UI:** http://localhost:8080/admin (use `ADMIN_API_KEY`)
- **Moderator UI:** http://localhost:8080/moderate
- **RabbitMQ Management:** http://localhost:15672 (guest/guest)
- **Overlay:** http://localhost:3002 (if running)

## Testing End-to-End Flows

### Test 1: Full Donation Flow (UI → Backend → RabbitMQ → Kollekt)

This tests the complete flow from donation creation through event delivery.

**Steps:**

1. **Create a donation via the Admin UI:**
   - Go to http://localhost:8080/admin/simulate
   - Enter donor email and amount
   - Click "Add Donation"

2. **Verify donation was persisted:**
   - Check the backend database via Prisma Studio:
     ```bash
     cd server && npx prisma studio
     ```
   - Look for a new `Donation` record with your email

3. **Configure RabbitMQ destination in the Admin UI:**
   - Go to http://localhost:8080/admin/destinations
   - Click "Add Destination"
   - Select **RabbitMQ** transport
   - Enter connection details:
     - **URL:** `amqp://guest:guest@rabbitmq:5672`
     - **Exchange:** `donations` (create a new one)
     - **Routing Key:** `*.donation`
   - Subscribe to event `donation.created`
   - Save

4. **Create another test donation:**
   - Go to http://localhost:8080/admin/simulate again
   - The new donation should be published to RabbitMQ

5. **Verify Kollekt consumed the event:**
   - Check Kollekt logs:
     ```bash
     docker logs esa-kollekt
     ```
   - Look for messages indicating it received and processed the donation

6. **Verify Overlay received the event:**
   - Check Overlay logs:
     ```bash
     docker logs esa-layouts-v2
     ```
   - Confirm the donation was added to the overlay state

### Test 2: API Integration (Tiltify-Compatible REST API)

> **⚠️ Branch requirement — verified 2026-09-29:** the Tiltify-compatible REST API
> (`server/routes/tiltify.ts`) and the Tiltify-compatible RabbitMQ message format
> (ADR-0009) do **not** exist on `main` in this checkout. They are implemented on
> `dev` (PR #138 `feat/117-tiltify-rest-api`, PR #132 `feat/116-tiltify-messages`),
> which is 49 commits ahead of `main` as of this writing. `main` currently
> publishes a PII-safe payload (`amount_cents`, `channel_id`, `donor_ref` —
> see `server/services/eventDelivery.ts`), not the Tiltify shape
> (`amount.value`, `donor_name`, `reward_claims[]`, ...) that the real Kollekt
> and esa-layouts-v2 consumers parse. **If `docker-compose.e2e.yml` builds
> `dono-backend`/`dono-frontend` from a `main` checkout, this scenario will
> 404 and real consumers will not understand the donation messages Test 1
> produces.** Check out `dev` (or the specific `feat/116`/`feat/117` branches)
> before running this scenario, or confirm with a maintainer which branch is
> deployed where you're testing.

This tests Kollekt and Overlay's ability to fetch campaign/incentive data.

**Steps:**

1. **Create a channel via Admin UI:**
   - On `main`: go to http://localhost:8080/admin/channels (the model is
     called `Channel`/`channel_id` on `main`; CLAUDE.md's "Event"/`event_id`
     terminology and `/api/events` route describe the `dev` branch's renamed
     model, not what's on `main` today — see ADR-0008 for the rename history).
   - On `dev`: go to http://localhost:8080/admin/events instead.
   - Create a new channel/event (e.g., "Test Marathon") and note its id.

2. **Create incentives:**
   - Add a Reward (e.g., "T-Shirt")
   - Add a Poll (e.g., "What color?")
   - Add a Goal (e.g., "Reach $1000")

3. **Verify Kollekt can fetch campaign data (dev branch only):**
   - Make a direct API call to the Tiltify-compatible endpoint. Verified
     paths from `dev`'s `server/routes/tiltify.ts` (mounted at `/api/tiltify`
     in `server/index.ts`, **not** under `/api/admin`):
     ```bash
     curl -X GET http://localhost:3001/api/tiltify/campaigns/<channel-id>
     curl -X GET http://localhost:3001/api/tiltify/campaign/<channel-id>/rewards
     curl -X GET http://localhost:3001/api/tiltify/campaign/<channel-id>/polls
     curl -X GET http://localhost:3001/api/tiltify/campaign/<channel-id>/targets
     curl -X GET http://localhost:3001/api/tiltify/campaign/<channel-id>/milestones
     ```
   - On `main` these all 404 — there is no `/api/tiltify` router mounted.

4. **Create a pledge with incentives:**
   - Go to http://localhost:8080/donate
   - Select the channel/event you created
   - Add items to cart (reward, poll vote, goal contribution)
   - Create the pledge (checkout not required if `STRIPE_SECRET_KEY` is unset)

5. **Simulate completing the donation:**
   - Use the admin simulate endpoint (verified at `server/routes/admin.ts:399`,
     mounted under `/api/admin` in `server/index.ts` — this one is correct
     on both `main` and `dev`):
     ```bash
     curl -X POST http://localhost:3001/api/admin/simulate-donation \
       -H "Authorization: Bearer key_admin_change-me" \
       -H "Content-Type: application/json" \
       -d '{"email":"test@example.com","amount_cents":5000}'
     ```

6. **Verify Overlay displays the donation with correct incentives:**
   - Check Overlay logs for the donation event
   - Overlay should show all three incentive types that were part of the pledge

### Test 3: Message Flow Only (RabbitMQ)

If you only want to test message delivery without the full consumer setup:

```bash
# Start only backend and RabbitMQ
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml up -d rabbitmq dono-backend dono-frontend

# Configure a test destination in Admin UI and watch messages flow to RabbitMQ
# Monitor RabbitMQ Management UI at http://localhost:15672
```

## RabbitMQ Configuration Details

### Exchange and Routing

The backend publishes to a configured exchange. By default:

- **Exchange Name:** `donations` (configurable in Admin UI)
- **Routing Keys:**
  - `donation.created`
  - `donation.moderated`
  - `incentive.created`
  - `incentive.enabled`
  - `incentive.disabled`
  - `incentive.value_changed`

**Kollekt expects:**

- Exchange binding on `*.donation` (e.g., `donation.created`)
- Messages in Tiltify-compatible format (documented in ADR-0009)

**esa-layouts-v2 expects:**

- `<slug>.donation` for donation events
- `<slug>.fact.updated` for incentive/campaign updates
- Tiltify-compatible message format

### Message Format

The backend publishes messages in Tiltify-compatible format. See `docs/adr/0009-tiltify-compatible-messages.md` for the full schema.

**Example donation event:**

```json
{
  "type": "donation.created",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "created": "2024-01-15T12:00:00Z",
  "donation": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": {
      "value": "50.00"
    },
    "donor_name": "Anonymous Donor",
    "donor_comment": "Great stream!",
    "completed_at": "2024-01-15T12:00:00Z",
    "hidden_from_overlay": false,
    "reward_claims": [],
    "poll_votes": [],
    "target_contributions": []
  }
}
```

## Troubleshooting

### RabbitMQ Connection Issues

```bash
# Test RabbitMQ connectivity from backend container
docker exec esa-dono-backend curl -s http://rabbitmq:15672/api/whoami

# Check RabbitMQ logs
docker logs esa-rabbitmq

# Access RabbitMQ Management UI
# http://localhost:15672 (default: guest/guest)
```

### Kollekt Not Consuming Messages

```bash
# Check if Kollekt is running
docker ps | grep esa-kollekt

# View Kollekt logs for errors
docker logs -f esa-kollekt

# Verify Kollekt can reach RabbitMQ
docker exec esa-kollekt \
  curl -s -u guest:guest http://rabbitmq:15672/api/whoami
```

### Overlay Not Receiving Events

```bash
# Check overlay logs
docker logs -f esa-layouts-v2

# Verify overlay can reach RabbitMQ and backend API
docker exec esa-layouts-v2 \
  curl -s http://dono-backend:3001/api/health

# Check if messages are being published to the correct queue/exchange
# Use RabbitMQ Management UI to inspect queue messages
```

### Database Issues

```bash
# Reset the database
cd server
npx prisma migrate reset

# Re-seed test data
npx prisma db seed

# Open Prisma Studio to inspect data
npx prisma studio
```

## Environment Variables Reference

See `docker-compose.e2e.yml` and the comments in the original `.env.example` for all available options.

**Key variables for e2e testing:**

| Variable                | Purpose                                  | Example                                  |
| ----------------------- | ---------------------------------------- | ---------------------------------------- |
| `ADMIN_API_KEY`         | Admin authentication (required)          | `key_admin_change-me`                    |
| `RABBITMQ_USER`         | RabbitMQ credentials                     | `guest`                                  |
| `RABBITMQ_PASS`         | RabbitMQ credentials                     | `guest`                                  |
| `API_BASE_URL`          | URL for Kollekt/Overlay to reach backend | `http://dono-backend:3001/api`           |
| `KOLLEKT_BUILD_CONTEXT` | Path to kollekt repository               | `../../../kollekt`                       |
| `OVERLAY_BUILD_CONTEXT` | Path to esa-layouts-v2 repository        | `../../../esa-layouts-v2`                |
| `STRIPE_SECRET_KEY`     | Stripe integration (optional)            | (leave empty for testing without Stripe) |

## Docker Compose Profiles

The compose file uses Docker Compose profiles to make services optional:

```bash
# Start only the core stack (backend + frontend + RabbitMQ)
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml up -d

# Add Kollekt
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-kollekt up -d

# Add both Kollekt and Overlay
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml --profile with-kollekt --profile with-overlay up -d
```

## Cleanup

```bash
# Stop all services
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml down

# Remove all data volumes (WARNING: deletes database)
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml down -v

# Rebuild images from scratch
docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml build --no-cache
```

## Additional Resources

- **ADR-0005:** Outbound Webhooks & Event Delivery (`docs/adr/0005-outbound-webhooks.md`)
- **ADR-0009:** Tiltify-Compatible Messages (`docs/adr/0009-tiltify-compatible-messages.md`)
- **ADR-0010:** Tiltify-Compatible REST API (`docs/adr/0010-tiltify-compatible-rest-api.md`)
- **Deployment Guide:** `docs/deployment.md`
- **Kollekt Repository:** https://github.com/esamarathon/kollekt
- **esa-layouts-v2 Repository:** https://github.com/esamarathon/esa-layouts-v2
