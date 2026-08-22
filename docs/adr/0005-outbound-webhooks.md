# ADR-0005: Event Delivery

**Date:** 2026-08-19

**Status:** Accepted

## Context

Admins need to receive notifications when key events occur on the platform: new donations, donation moderation changes, and incentive lifecycle changes (create / enable / disable / value change) across rewards, polls, and goals.

Two delivery transports are supported: **webhook** (HTTP POST) and **message queue** (RabbitMQ). The underlying infrastructure is the same persistent queue; only the transport varies.

## Decisions

### Delivery model: in-process outbox + SQLite-backed persistent queue

The app is deliberately infra-light: backend + nginx containers, single SQLite file on a `/data` volume, no Redis, no message broker. Introducing a queue or broker now would require significant new infrastructure.

The design uses a persistent `EventDelivery` table as an outbox: emit sites write a row (atomically with the triggering data change) and a `setInterval` worker delivers it. This is consistent with the existing pledge/email pattern (`sendMagicLink` is fire-and-forget in `donation.ts:117-119`).

**Tradeoff:** the worker runs in the same Node process as the API. A crashed worker loses in-flight ticks but delivery rows survive SQLite. The queue is bounded by `max_attempts` (default 5, with exponential backoff) and surfaced in the admin UI. This is acceptable for current scale.

### FIFO: per-destination, single-flight

Ordering is guaranteed **per destination** (not globally across all destinations):

- `seq` column provides a monotonic sequence number per destination.
- The dispatcher processes each destination's queue strictly in `seq` order.
- One in-flight delivery per destination at a time (concurrency is _across_ destinations only).
- If the head delivery fails, that destination's queue **stalls** — it does not skip ahead to `seq+1`. This preserves ordering at the cost of blocking on a sick destination.
- A permanently-dead destination eventually exhausts `max_attempts` → `FAILED` (terminal poison-message escape), and the head advances.

**Consumer contract:** at-least-once delivery with deduplication on `X-Webhook-Delivery` header (the delivery `id`). Consumers must handle duplicate delivery of the same event.

### PII: allowlist serialization, donor pseudonymous reference

Payloads are built with explicit allowlist serializers — Prisma objects are **never** spread directly into payloads. A test asserts that forbidden keys (`email`, `donor_name`, `donor_email`, `comment`, `moderated_by`) never appear.

The `donor_ref` field in `donation.created` and `donation.moderated` is the `Donor.id` cuid (cuid v1 — timestamp + counter + server fingerprint; no donor-derived data). This enables per-donor correlation without exposing identity.

**Decision:** `external_id` (Stripe Checkout Session id) is included in `donation.created` and `donation.moderated` payloads. It is a payment-system identifier, not PII.

### Signing: Stripe-style HMAC-SHA256

Payloads are signed with the destination's per-destination secret using HMAC-SHA256 over `${timestamp}.${rawBody}`, producing the header `X-Webhook-Signature: t=<timestamp>,v1=<hexsig>`. This matches the mental model already established for Stripe webhook verification in the codebase.

Note: HMAC signing applies only to HTTP destinations. RabbitMQ relies on broker authentication and TLS for integrity.

### Retry: exponential backoff, max 5 attempts

On non-2xx response or network error: `attempts++`; if `< max_attempts`, reschedule `next_attempt_at` with backoff = `min(2^attempts minutes, 60 min)`. If exhausted → `FAILED`. The dispatcher ticks every 15 seconds.

### SSL verification: configurable per destination

`verify_ssl: false` sets `rejectUnauthorized: false` on the HTTPS agent, allowing self-signed certificates in development environments.

## Future: sidecar extraction (post-Postgres)

This design is explicitly structured so the delivery loop can be lifted into a separate process without changing emit sites. The trigger is migration to Postgres: SQLite serializes writes and a second process contending on the same file risks `SQLITE_BUSY` errors under load.

With Postgres, `EventDelivery` becomes a clean outbox table, and the worker can use `SELECT ... FOR UPDATE SKIP LOCKED` or `LISTEN/NOTIFY` for more robust coordination. See the tracking issue: "Extract event delivery into a sidecar worker (post-Postgres)".

## Event types

| Event                     | Emit site                                  | Payload contract                                                            |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `donation.created`        | `donation.ts` (post-commit, non-duplicate) | `{ donation_id, external_id, amount_cents, channel_id, donor_ref }`         |
| `donation.moderated`      | `moderator.ts`                             | `{ donation_id, external_id, donor_ref, moderated, moderated_at }`          |
| `incentive.created`       | admin.ts POST rewards/polls/goals          | `{ incentive_kind, incentive_id, title, is_active, <value fields> }`        |
| `incentive.enabled`       | admin.ts PUT (is_active false→true)        | `{ incentive_kind, incentive_id, title }`                                   |
| `incentive.disabled`      | admin.ts PUT/DELETE (is_active true→false) | `{ incentive_kind, incentive_id, title }`                                   |
| `incentive.value_changed` | admin.ts PUT (diff cost/ends_at/target)    | `{ incentive_kind, incentive_id, title, changed_fields, <old/new values> }` |

## Schema

- `EventDestination`: url, secret, is_active, event_types (JSON array string), verify_ssl, description, destination_type, amqp_url, amqp_exchange, amqp_routing_key
- `EventDelivery`: destination_id FK, seq, event_type, payload (JSON string), status, attempts, max_attempts, next_attempt_at, last_status_code, last_error
- `EventDestinationSeq`: destination_id PK FK → destination, seq counter (upserted atomically on each insert)

## Destination types

Two transport types are supported via `EventDestination.destination_type`:

| Field              | Type                 | Notes                                                                           |
| ------------------ | -------------------- | ------------------------------------------------------------------------------- |
| `destination_type` | `HTTP` \| `RABBITMQ` | Default `HTTP`                                                                  |
| `amqp_url`         | String?              | Required for RabbitMQ. `amqp://` or `amqps://`. Embedded credentials supported. |
| `amqp_exchange`    | String               | Default `""` (default exchange)                                                 |
| `amqp_routing_key` | String?              | Required for RabbitMQ                                                           |

### HTTP (default)

HMAC-SHA256 signed POST with per-destination secret, SSL verification toggle, exponential backoff. The `X-Webhook-Signature`, `X-Webhook-Event`, and `X-Webhook-Delivery` headers are included on every HTTP delivery.

### RabbitMQ

Published to `amqp_exchange` (default = default exchange) with `amqp_routing_key` as the routing key. No HMAC signing — integrity relies on broker auth (credentials in `amqp_url`) and TLS (`amqps://`). Pre-provisioned topology is assumed: the app does not declare or assert the exchange or queue exists.

**Connection reuse**: a module-level `Map<destinationId, {connection, channel}>` cache holds one confirm-channel per destination. On publish error the cached entry is evicted so the next tick reconnects cleanly.

**Publisher confirms** are used: the confirm callback maps confirmed → `200` (success) and nack/timeout/connection error → `0` + error message (failure). Failures feed the same retry/backoff/FIFO-stall logic as HTTP.

**amqplib** is the client library, imported lazily via dynamic `import('amqplib')` so HTTP-only deployments never load it.
