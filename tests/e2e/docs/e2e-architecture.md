# ESA E2E Testing Architecture

> **⚠️ This document describes the target design once `dev` is merged, not what
> `main` runs today.** Verified 2026-09-29 against this checkout: `main` is 49
> commits behind `dev` and lacks `server/routes/tiltify.ts` (the
> Tiltify-compatible REST API, PR #138) and the Tiltify-compatible message
> builder (PR #132). On `main`, `eventDispatcher.ts` publishes a PII-safe
> payload (`amount_cents`, `channel_id`, `donor_ref`) instead of the
> `amount.value`/`donor_name`/`reward_claims[]` shape shown in the diagrams
> below, and there is no `/api/tiltify/*` router — only `/api/channels`,
> `/api/campaign`, `/api/admin`, etc. (see `server/index.ts`). The diagrams
> are accurate for `dev` (and for the real Kollekt/esa-layouts-v2 consumers,
> per ADR-0009/0010) but will not match a `main` build. Kollekt and
> esa-layouts-v2 themselves are private repos — their internal env vars,
> ports, and Dockerfile paths in this document are inferred from ADR prose,
> not from their source.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ESA End-to-End Testing Stack                        │
└─────────────────────────────────────────────────────────────────────────────┘

                              Browser / Admin UI
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  Frontend    │  │  Admin UI    │  │  Moderator   │
            │  (Donation)  │  │  (Simulate)  │  │  Dashboard   │
            │              │  │              │  │              │
            │ :8080        │  │ :8080/admin  │  │ :8080/mod    │
            └──────────────┘  └──────────────┘  └──────────────┘
                    │                │                │
                    └────────────────┼────────────────┘
                                     │
                         HTTP / REST API
                                     │
                    ┌────────────────▼────────────────┐
                    │                                 │
                    │      esa-dono-ui Backend        │
                    │      (Express + Prisma)         │
                    │                                 │
                    │ • Donation processing           │
                    │ • Pledge management             │
                    │ • Event/Reward/Poll CRUD        │
                    │ • Tiltify-compatible REST API   │
                    │ • Outbound event publishing     │
                    │                                 │
                    │ :3001                           │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────┴────────────────────────┐
                    │                                         │
                    │         Outbound Events via AMQP        │
                    │    (Admin configurable destinations)    │
                    │                                         │
                    ▼                                         ▼
            ┌──────────────────┐                  ┌──────────────────┐
            │    RabbitMQ      │                  │    HTTP/REST     │
            │  Message Broker  │                  │   Webhooks       │
            │                  │                  │  (Optional)      │
            │  • Exchanges     │                  │                  │
            │  • Queues        │                  │  External        │
            │  • Bindings      │                  │  Systems         │
            │                  │                  │                  │
            │ amqp://localhost │                  │                  │
            │     :5672        │                  │                  │
            │                  │                  │                  │
            │ mgmt :15672      │                  │                  │
            └────────┬─────────┘                  └──────────────────┘
                     │
         ┌───────────┴────────────┐
         │                        │
    Topic: *.donation             │
    Event: donation.created   (Optional)
         │                        │
         ▼                        ▼
   ┌──────────────┐        ┌──────────────────┐
   │   Kollekt    │        │  esa-layouts-v2  │
   │              │        │  (OBS Overlay)   │
   │ .NET         │        │                  │
   │ Consumer     │        │ TypeScript/Node  │
   │              │        │ Consumer         │
   │ • Consumes   │        │                  │
   │   events     │        │ • Consumes       │
   │ • Processes  │        │   <slug>.donation│
   │   donations  │        │ • Reads campaign │
   │ • Reads      │        │   data via REST  │
   │   campaign   │        │ • Updates        │
   │   data       │        │   overlay state  │
   │              │        │ • Displays       │
   │ :5000        │        │   donations      │
   │ (or config)  │        │                  │
   └──────────────┘        │ :3002            │
                           └──────────────────┘
                                   │
                                   │
                           Stream Overlay Output
                           (Browser / OBS)
```

## Data Flow Diagrams

### Flow 1: Donation Creation → Message Publishing

```
Admin UI
   │
   ▼ POST /admin/simulate-donation
   │ or
   ▼ POST /api/pledge + Stripe webhook
   │
┌──────────────────────────────────┐
│  Backend: processDonation()      │
│                                  │
│ 1. Upsert donor                  │
│ 2. Create donation record        │
│ 3. Fulfill pledge items          │
│ 4. Trigger event: donation.created
│ 5. Enqueue outbound event        │
└──────────────────────────────────┘
   │
   ▼ EventDelivery (outbox pattern)
   │
┌──────────────────────────────────┐
│  Event Publisher Worker          │
│                                  │
│ 1. Poll EventDelivery table      │
│ 2. For each RabbitMQ destination:│
│    - Publish to exchange         │
│    - Mark delivered              │
│    - Retry on failure (5 times)  │
└──────────────────────────────────┘
   │
   ▼ AMQP exchange: "donations"
   │ routing_key: "donation.created"
   │
RabbitMQ
   │
   ├─────┬──────────┬────────────┐
   │     │          │            │
   ▼     ▼          ▼            ▼
  Kollekt  esa-layouts-v2  External Webhook  ...
```

### Flow 2: Kollekt Consumption & Processing

```
RabbitMQ Queue
   │
   ├─ Message: {type: "donation.created", donation: {...}}
   │
   ▼ Kollekt AMQP Consumer
   │
┌────────────────────────────────────┐
│  Kollekt: Message Handler          │
│                                    │
│ 1. Validate message format         │
│    (Tiltify-compatible schema)     │
│ 2. Parse donation & incentives     │
│ 3. Fetch campaign from REST API    │
│    GET /api/tiltify/campaigns/:id  │
│ 4. Upsert donation to local state  │
│ 5. Update reward/poll/goal totals  │
│ 6. ACK message                     │
└────────────────────────────────────┘
   │
   ▼ Donation is now available to Kollekt consumers
   │ (e.g., streaming overlays, chatbots, leaderboards)
```

### Flow 3: esa-layouts-v2 Consumption & Display

```
RabbitMQ Queue
   │
   ├─ Topic: "<slug>.donation" (e.g., "main.donation")
   ├─ Topic: "<slug>.fact.updated"
   │
   ▼ esa-layouts-v2 AMQP Consumer
   │
┌──────────────────────────────────────┐
│  Overlay: Message Handler            │
│                                      │
│ 1. Bind to <slug>.donation queue     │
│ 2. When donation event arrives:      │
│    a. Fetch campaign data via API    │
│    b. Format for display             │
│    c. Add to overlay state           │
│    d. Emit WebSocket event           │
│ 3. OBS (or browser) receives update  │
│ 4. Display donation alert & totals   │
└──────────────────────────────────────┘
   │
   ▼ WebSocket / HTTP polling
   │
┌──────────────────────────┐
│  OBS / Browser           │
│                          │
│  ┌────────────────────┐  │
│  │ "Donation Alert!"  │  │
│  │ John donated $50   │  │
│  │ towards "Goal"     │  │
│  └────────────────────┘  │
│                          │
│  Total: $12,345          │
│  Goal: $50,000 (24%)     │
└──────────────────────────┘
```

## Service Networking

```
Docker Network: esa-e2e (internal bridge)

┌─────────────────────────────────────────────┐
│  Host Network (Docker host)                 │
│                                             │
│  Exposed Ports:                             │
│  • 8080   → dono-frontend nginx             │
│  • 3001   → dono-backend express            │
│  • 3002   → overlay web server (optional)   │
│  • 5672   → rabbitmq amqp                   │
│  • 15672  → rabbitmq management UI          │
│                                             │
└────────────────┬────────────────────────────┘
                 │
        Docker bridge (esa-e2e)
                 │
    ┌────────────┼────────────┬──────────┬──────────┐
    │            │            │          │          │
    ▼            ▼            ▼          ▼          ▼
 ┌──────┐   ┌──────┐    ┌────────┐ ┌────────┐ ┌──────┐
 │FE    │   │BE    │    │RabbitMQ │ │Kollekt │ │Overlay│
 │:8080 │   │:3001 │    │ :5672   │ │:? (int)│ │:3002 │
 │      │   │      │    │         │ │        │ │      │
 └──────┘   └──────┘    └────────┘ └────────┘ └──────┘
    ▲          ▲           ▲
    │          │           │
    └──────────┼───────────┘
         Service DNS
      (container names)

Internal hostnames:
• dono-frontend (resolved by Docker DNS)
• dono-backend
• rabbitmq
• esa-kollekt (if running)
• esa-layouts-v2 (if running)
```

## Environment Configuration Flow

```
.env file
   │
   ├─ Core config (ADMIN_API_KEY, DATABASE_URL, etc.)
   │
   ├─ docker-compose.e2e.yml reads:
   │  ├─ Service port mappings
   │  ├─ Build contexts (KOLLEKT_BUILD_CONTEXT, etc.)
   │  ├─ Docker image tags
   │  └─ Service dependencies
   │
   ├─ Backend container receives:
   │  ├─ Stripe config (optional)
   │  ├─ OAuth config (optional)
   │  ├─ Email config (optional)
   │  └─ OTEL config (optional)
   │
   ├─ Kollekt receives (via environment):
   │  ├─ AMQP_HOST=rabbitmq
   │  ├─ API_BASE_URL=http://dono-backend:3001/api
   │  └─ LOG_LEVEL
   │
   └─ Overlay receives (via environment):
       ├─ AMQP_URL=amqp://guest:guest@rabbitmq:5672/
       ├─ API_BASE_URL=http://dono-backend:3001/api
       └─ PORT=3002
```

## Message Queue Setup

```
RabbitMQ Default Setup:
   User: guest
   Pass: guest
   Vhost: /

Configured via Admin UI at runtime:

Exchange Configuration:
  Name: "donations" (or custom)
  Type: "topic"
  Durable: yes
  Auto-delete: no

Binding from Exchange to Queues:
  Exchange: "donations"
  Routing Key: "*.donation" or "donation.*"

  Queue: "donation-consumer-queue" (example)
  Binding Key: "*.donation"

Topics Published by Backend:
  • donation.created
  • donation.moderated
  • incentive.created
  • incentive.enabled
  • incentive.disabled
  • incentive.value_changed

Topic Consumed by Kollekt:
  • *.donation (matches any donation.* event)

Topic Consumed by esa-layouts-v2:
  • <slug>.donation (e.g., "main.donation")
  • <slug>.fact.updated (e.g., "main.fact.updated")
```

## Database Schema Relationships

```
Donor
  │
  ├─ many ──→ Donation ──┐
  │                       │
  │                       ├─ many ──→ RewardClaim
  │                       │
  │                       ├─ many ──→ PollVote
  │                       │
  │                       └─ many ──→ FundContribution
  │
  └─ magic_token (for session)
     balance_remaining

Event (Campaign / Stream)
  │
  ├─ many ──→ Reward
  │
  ├─ many ──→ Poll
  │   │
  │   └─ many ──→ PollOption
  │       │
  │       └─ many ──→ PollVote
  │
  ├─ many ──→ FundGoal
  │   │
  │   └─ many ──→ FundContribution
  │
  └─ many ──→ Donation

EventDelivery (Outbox pattern)
  │
  ├─ status: PENDING | DELIVERED | FAILED
  ├─ event_type: donation.created, incentive.created, etc.
  ├─ destination_id: FK → Destination
  ├─ payload: JSON
  ├─ retry_count: 0-5
  └─ next_retry_at: timestamp
```

## Request/Response Flow Example

### Creating a Donation via Admin Simulate

```
1. User Action
   POST http://localhost:8080/admin/simulate-donation
   Authorization: Bearer key_admin_change-me
   Body: {email: "donor@example.com", amount_cents: 5000}

2. Frontend → Backend
   → dono-backend:3001/api/admin/simulate-donation

3. Backend Processing
   ├─ Upsert Donor
   ├─ Create Donation record
   ├─ Create EventDelivery rows (one per RabbitMQ destination)
   ├─ Trigger webhook/event handlers
   └─ Return: {success: true, token, donor}

4. Event Publishing (outbox pattern)
   ├─ Worker polls EventDelivery table
   ├─ For each PENDING row:
   │  ├─ Connect to RabbitMQ destination
   │  ├─ Publish to exchange (routing_key: "donation.created")
   │  ├─ Await publisher confirm
   │  └─ Mark as DELIVERED
   └─ (On failure, retry with exponential backoff)

5. RabbitMQ Fanout
   ├─ Exchange receives: donation.created message
   ├─ Routes to bound queues based on routing_key
   ├─ Kollekt queue receives: message
   └─ esa-layouts-v2 queue receives: message

6. Kollekt Consumption
   ├─ Dequeue from rabbit
   ├─ Parse Tiltify-compatible format
   ├─ Fetch campaign data from backend API
   ├─ Update local donor/donation state
   └─ ACK message

7. Overlay Consumption
   ├─ Dequeue from rabbit
   ├─ Parse event format
   ├─ Fetch additional campaign/incentive data from API
   ├─ Update overlay state
   ├─ Emit WebSocket event to connected clients
   └─ ACK message

8. User Sees Result
   ├─ Frontend polls donation total (GET /api/campaign)
   ├─ OBS / Browser receives WebSocket: new donation
   ├─ Donation alert displays on stream
   └─ Total tally updates
```

## Optional: Multiple Events / Channels

When running multiple simultaneous streams/events:

```
Event 1 (ESA Speedrun)      Event 2 (ESA Charity)
        │                            │
        ├─ Rewards                   ├─ Rewards
        ├─ Polls                     ├─ Polls
        └─ Goals                     └─ Goals
        │                            │
        └─────────┬──────────────────┘
                  │
           Shared Pool of Donations
           (via common Event ID)
                  │
        ┌─────────┴──────────┐
        │                    │
        ▼                    ▼
   Overlay 1            Overlay 2
   (speedrun stream)    (charity stream)
        │                    │
        └─────────┬──────────┘
                  │
        Aggregate Totals
        (public campaign page)
```

Each donation is routed to its Event, and each Overlay connects to relevant RabbitMQ queues (`speedrun.donation`, `charity.donation`, etc.).
