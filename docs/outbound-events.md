# Outbound Event Delivery (Webhooks & RabbitMQ)

Admins can configure destinations at `/admin/destinations` to receive notifications when platform events occur — new donations, moderation changes, and incentive lifecycle changes (create/enable/disable/value-change) across rewards, polls, and goals.

**Event types:** `donation.created`, `donation.moderated`, `incentive.created`, `incentive.enabled`, `incentive.disabled`, `incentive.value_changed`

Each destination picks a transport:

- **HTTP** — signed POST with `X-Webhook-Signature: t=<ts>,v1=<hmac>` (Stripe-style HMAC-SHA256), configurable SSL verification for self-signed certs
- **RabbitMQ** — published via `amqplib` to a configured exchange/routing key, using publisher confirms

**Delivery guarantees:**

- At-least-once, per-destination FIFO ordering — one destination stalling on a bad response never blocks or reorders another destination's queue
- Persistent SQLite-backed outbox (`EventDelivery` table) — survives process restarts; a destination outage is tolerated for roughly an hour (5 retry attempts, exponential backoff capped at 60 min) before the delivery is marked permanently `FAILED`
- Payloads are PII-safe: explicit allowlist serializers, never a raw Prisma object spread. Donor identity is a pseudonymous `donor_ref` (the donor's opaque `id`) — never email, name, or comment

No environment variables are required for this feature — destinations, secrets, and RabbitMQ connection URLs are all configured at runtime through the admin UI, not `.env`.

For the full design rationale (outbox model, retry/backoff schedule, FIFO semantics, PII allowlist details, and RabbitMQ publisher-confirm mechanics), see [ADR-0005](adr/0005-outbound-webhooks.md).
