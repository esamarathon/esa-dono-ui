# ADR-0007: Webhook Delivery Semantics

**Date:** 2026-09-28

**Status:** Accepted

**Supersedes in part:** [ADR-0005](0005-outbound-webhooks.md). It replaces ADR-0005's delivery model, FIFO and retry sections. Transports, signing and the PII allowlist are unchanged.

**Related:** PRD-0002 §Q, §M; esamarathon/esa-dono-ui#109

## Context

ADR-0005 said the per-Destination queue stalls on a failing head and that emits are written atomically with the triggering change. The code did neither:

- **FIFO was broken.** The head query filtered on `next_attempt_at <= now`. A message waiting to retry was therefore skipped, and the next message was sent before it. On staging, webhook.site answered HTTP 429, and later messages went out around the ones being retried.
- **Messages were sent on a timer.** One message per Destination every 15 s: at most 4 per minute, with about 7.5 s median latency.
- **There was no single-flight guard.** Overlapping ticks could send a row twice, or out of order.
- **Emits were not atomic.** `emitWebhookEvent` ran after commit and was fire-and-forget. `seq` was allocated in a separate transaction, so a crash could lose a message, and `seq` followed callback order, not commit order. One emit site also published pledge-routed donations with `channel_id: null`.
- **Outages were treated as failures.** After 5 attempts a message was marked `FAILED` and skipped, even when the endpoint was simply down.
- **AMQP could hang.** A publish confirm had no timeout, and the cached connection had no `error`/`close` handler.

The consumers (kollekt, esa-layouts-v2) need donations in order and must not lose any. Payments are already taken when a message is created, so dropping a message is never acceptable.

## Decision

1. **Transactional outbox.** `withWebhooks(fn)` runs the change and its emits in one transaction. `seq` is allocated in the same transaction, and SQLite serialises writers, so `seq` order is commit order. After commit it wakes the Destinations that received a message. Every emit site uses it.
   **One SQLite connection.** `lib/prisma.ts` adds `connection_limit=1` to a SQLite `DATABASE_URL` and raises the transaction start wait to 15 s. With Prisma's default pool, concurrent interactive transactions on separate connections deadlock: each holds a read lock that blocks the other's commit. This was already true before this change. Measured with 20 and 50 simultaneous `simulate-donation` requests against the previous release image: 1 of 20 succeeded and 19 returned 500 after about 55 s; 1 of 50 succeeded, 23 returned 500 and 26 returned 504. With one connection, 20 of 20 and 50 of 50 committed, and every webhook message was delivered. The same deadlock would affect a burst of Stripe webhooks, and the outbox puts every emit inside those transactions. The consequence: code inside a transaction must use the transaction client, never the global one, or it waits for itself. `resolvePledge` now takes the caller's `tx`.
2. **Strict FIFO with a stall.** The head is the lowest-`seq` `PENDING` row, selected **without** a time filter. If the head is not due, the Destination waits. Later rows never overtake it.
3. **Two failure classes**, decided by where the failure is detected:
   - **Endpoint** failures are anything the endpoint or transport reports, including every HTTP 4xx. They retry forever, with backoff 5/15/60/180 s and then 180 s.
   - **Message** failures are problems detected without contacting the endpoint: an empty or unparseable payload. They become `FAILED`, and the queue moves on.

   A consumer bug that returns 400 must never make the queue skip messages. `max_attempts` is removed.

4. **Drain and wake.** A woken Destination sends until its queue is empty, the head is not due, or an endpoint failure occurs. A 5 s interval is a safety net.
5. **In-process single-flight.** One in-flight drain per Destination. A wake during a drain sets a "run again" flag, so it is not lost. This works because the app runs as one process. Multiple processes would need a database lease, which is out of scope.
6. **AMQP hardening.** Publisher-confirm timeout of 10 s (`WEBHOOK_AMQP_CONFIRM_TIMEOUT_MS`), a 30 s heartbeat, and `error`/`close` handlers that evict the cached connection. Success means the broker accepted the message.
7. **Message identity.** `WebhookDelivery.message_id` is one UUID per webhook message. All Destination rows for that message share it, and it is stable across retries. It is the envelope `id` for native payloads and is sent as the AMQP `messageId`.
8. **Retention and requeue.**
   - Retention: `SUCCESS` rows are deleted after 2 h and `FAILED` rows after 24 h. `PENDING` rows are never deleted.
   - Requeue: admins can requeue a `FAILED` message, which keeps its original `seq`.
9. **Observability.** Per-Destination gauges: queue depth, oldest pending age, failed count and last success. Alerting is how an outage is noticed, because an outage no longer produces `FAILED` rows.

## Consequences

- One sick Destination can hold a backlog without limit. That is intended: nothing is lost, and the backlog drains in order on recovery. Alerts on queue age make it visible.
- On recovery, consumers receive a burst of messages. Overlays may play an alert for each backlogged donation. Suppressing alerts by age is proposed upstream (esa-layouts-v2#5).
- A requeued message arrives after later messages that already succeeded. Consumers must deduplicate or upsert by id. kollekt and esa-layouts-v2 already do.
- A message cannot be recovered once its row is deleted by retention. Reconciliation is tracked in #118.
- Single-flight is per process. Running two backend replicas would need a database lease before scaling out.
- With one SQLite connection, database work is serialised in-process. That is SQLite's real concurrency model anyway, but a long transaction now delays every other request's transaction. Any query on the global client made from inside a transaction deadlocks until the timeout. Keep transactions short, and pass `tx` down.

## Alternatives Considered

- **Keep `max_attempts` and requeue manually.** Rejected: an outage longer than a few minutes would mark donations `FAILED` and skip them, which is the exact failure seen on staging.
- **Treat HTTP 4xx as message failures.** Rejected: a misbehaving or rate-limiting consumer would make the queue skip real donations.
- **Database lease for single-flight now.** Rejected for now: there is one process today, and a lease adds a polling and expiry protocol with no current benefit.
- **Emit after commit, idempotently.** Rejected: that leaves a window where a crash loses the message, and `seq` still would not follow commit order.
