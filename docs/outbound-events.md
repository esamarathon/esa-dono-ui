# Outbound Webhook Messages (HTTP & RabbitMQ)

Admins configure **Destinations** at `/admin/destinations`. A Destination receives a **webhook message** when something happens on the platform: a new donation, a moderation change, or an incentive change (create, enable, disable, value change) for rewards, polls and goals. Vocabulary: see [`CONTEXT.md`](../CONTEXT.md).

**Message types:** `donation.created`, `donation.updated`, `donation.moderated`, `donation.hidden`, `donation.unhidden`, `incentive.created`, `incentive.enabled`, `incentive.disabled`, `incentive.value_changed`, plus `ping` from the admin "Test ping" button.

Each Destination picks a transport:

- **HTTP**: a signed POST with `X-Webhook-Signature: t=<ts>,v1=<hmac>` (Stripe-style HMAC-SHA256), `X-Webhook-Event: <message type>` and `X-Webhook-Delivery: <delivery id>`. SSL verification can be turned off for self-signed certificates.
- **RabbitMQ**: published with `amqplib` to the configured exchange and routing key. The broker confirms each publish. Properties are `persistent`, `contentType: application/json`, `messageId: <message id>` and `type: <message type>`, with headers `x-webhook-event` and `x-webhook-delivery`.

## Formats

Each Destination also picks a **payload format**. Design: [ADR-0009](adr/0009-tiltify-compatible-messages.md).

- **Native** (default). The envelope `{ id, type, created_at, data }`, one message type per change, filtered by the Destination's `event_types`, sent with its routing key.
  - `donation.created` carries `donation_id`, `external_id`, `amount_cents` (new money), `status`, nullable `pledge_amount_cents`, `wallet_applied_cents`, `channel_id`, `event_id`, `donor_ref`, `donor_name`, `donor_comment`, `hidden_from_overlay` and `allocations`.
  - **`donation.updated` is opt-in**, through an explicit `event_types` subscription. No existing Destination is changed automatically. It carries the same full current `data` as creation. Replace the stored state by `donation_id`, not by adding allocation deltas. It is queued only when this stable content changes, not because a new message id or timestamp was generated.
  - `allocations` has `reward`, `poll` and `goal` arrays, live rows only. Every row carries `id`, `amount_cents` and `source` (`donor`, `auto`, `moderator`; claims are always `donor`). Rewards add `reward_id` and claim `status`; polls add `poll_id`, `poll_option_id` and option `status` (pending write-ins included); goals add `goal_id`. No claim answers, email or staff identities are included.
  - A credit-funded reward remains one whole claim even when several donations fund it. Its `amount_cents` is this source donation's effective share, not the whole price; `entitlement_amount_cents` and `carrier_donation_id` identify the full recorded price and stable oldest-source carrier. The same claim id can therefore appear in several native donation states: count the entitlement once, not once per funding component. Payment-refund reductions change effective funding without multiplying or cancelling other reward entitlements.
  - `donor_name` and `donor_comment` are the donor's public display data. They are null while the donation is hidden from the overlay.
  - `donation.hidden` / `donation.unhidden` are sent when a moderator hides or shows a donation.
  - Unassigned donations publish nothing until an admin assigns them.
  - `incentive.*` messages carry `event_id`, the Event the incentive belongs to (never null), and `channel_id`: its Channel, or null for a shared incentive, which every Channel of that Event shares (ADR-0012).
- **Tiltify-compatible** (`TILTIFY`, RabbitMQ only). Bare Tiltify-v5 objects for kollekt and esa-layouts-v2, with no envelope. The Destination's event types and routing key are ignored. The exchange defaults to `tiltify` and is declared `topic, durable, autoDelete`.

  | Routing key               | Body                                                                                                                                                                                                     | Sent when                                                                        |
  | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `<channel-slug>.donation` | the donation: `id`, `amount {currency, value, value_cents}`, `donor_name`, `donor_comment`, `created_at`, `completed_at`, `campaign_id` (Channel), `team_event_id` (Event), incentive scalars and arrays | introduced or changed public content (including reversals and write-in approval) |
  | `<slug>.fact.updated`     | `{ id, slug, name, total_amount_raised: {currency, value} }`                                                                                                                                             | counted money changes: once per affected Channel and Event                       |
  - `amount.value` is a string with two decimals.
  - A hidden donation is sent as `donor_name: "Anonymous"`, `donor_comment: null`, **without `completed_at`**. The overlay removes it, and an overlay that never saw it stays silent.
  - **`"Anonymous"` consequence:** a donor without a display name is also sent as `"Anonymous"`. The overlay therefore removes an anonymous donation after **any** republish of it: hide, show again, or an admin requeue. The fix is on the overlay side (esa-layouts-v2#5).
  - Showing a donation again re-adds it to the overlay **and plays the alert**.
  - The `moderated` review toggle and incentive changes are not sent in this format. Consumers read incentives from the REST API.
  - Every reversal, Pool credit spend, moderator assignment/undo and Payment refund calls the centralized publisher. A changed donation is re-published under the **same id**, excluding reversed rows. Identical Tiltify content is suppressed so staff actions do not replay alerts. The transition corrections are the only forced publications.
  - `amount` is donation money, never the sum of incentive allocations. Scalars retain the first selection, lists the full set, and `target_contributions[].amount` is the goal allocation. Pooled donor/auto rows are combined per option/goal. Source and staff identity are never sent in this format. A $10 donation can back $10 in each of three categories while `amount` remains $10.
  - A multi-source credit-funded reward appears once with quantity 1 under its stable oldest-source carrier donation. Donation `campaign_id`, money and ids stay source-routed even when the incentive belongs to another Channel; do not infer incentive ownership from the donation Channel.
  - A Wallet refund keeps money counted; a chargeback removes the remaining money. Totals are compared by counted amount, not just status: a Payment refund and a failed Payment refund restored as Wallet credit change totals even while status stays `COMPLETED`. Acceptance of `pending`, `requires_action` or `succeeded` lowers counted money immediately, not on final settlement. `REQUESTED` claim locking and creation rejection/restoration change native claim status only; identical Tiltify content and unchanged totals are suppressed. Later `failed`/`canceled` settlement is flagged without automatic accounting repair; only explicit Wallet-credit resolution restores item money. Shipping is never included in money, Wallet or Pool totals.

**Message identity.** Each message has one UUID, `message_id`, which is the AMQP `messageId`. For the native format it is also the envelope `id`. A requeue sends the same `message_id` again. Consumers deduplicate on it, or on the donation `id` (Tiltify consumers upsert by it).

No environment variables are needed. Destinations, secrets and RabbitMQ URLs are set at runtime in the admin UI. One optional variable, `WEBHOOK_AMQP_CONFIRM_TIMEOUT_MS` (default `10000`), changes the publish-confirm timeout.

## Consumer setup

kollekt and esa-layouts-v2 need two things from us: the **Tiltify-compatible messages** (a `TILTIFY` Destination, § Formats) and the **Tiltify-compatible REST API** at `<APP_BASE_URL>/api/tiltify/` ([ADR-0010](adr/0010-tiltify-compatible-rest-api.md)).

- **REST API.** It serves bare Tiltify-v5 objects and needs no key. The global per-IP API limit applies (`RATE_LIMIT_API`, default 600/min). kollekt polls about 36 times/min per Channel.
- **Totals match.** `total_amount_raised` on `campaigns/{id}` is the same money total as the `fact.updated` message. Incentive totals are allocated amounts, not money totals; their sum may exceed money. Never reconcile incentive sums against donation money.
- **Shared incentives** (no Channel) are listed under every Channel, and an Event lists none of its own.
- **Always empty:** milestones and matches are `[]`.

A Tiltify **campaign** is our **Channel** and the **team campaign** is our **Event**. Find their uuids and slugs at `/admin/events`. `GET /api/events` also shows them, but only for active Events and Channels.

| Consumer       | Setting                                    | Value                                                                                                    |
| -------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| kollekt        | `Rabbit.Url`                               | the broker of the `TILTIFY` Destination                                                                  |
| kollekt        | `TiltifyBridge.Url`                        | `<APP_BASE_URL>/api/tiltify/`: **keep the trailing slash** (.NET drops the last path segment without it) |
| esa-layouts-v2 | `rabbitmq.*`                               | the same broker                                                                                          |
| esa-layouts-v2 | `tiltify.api.url`                          | `<APP_BASE_URL>/api/tiltify`                                                                             |
| esa-layouts-v2 | `tiltify.teamCampaign.{slug,id}`           | the Event's slug and uuid                                                                                |
| esa-layouts-v2 | `tiltify.campaigns[].{slug,id,thisStream}` | each Channel's slug and uuid; `thisStream: true` on the one this layout instance shows                   |

**Coordinated consumer dependency:** pooled credit can attach another Channel's incentive to a source-routed donation. Cold or stale Kollekt caches therefore require the focused Kollekt [PR44](https://github.com/esamarathon/kollekt/pull/44) lookup/ingestion fix, in addition to global shared-id handling (kollekt#36). The authorized fix uses the optional same-Event/shared owner lookup in `docs/api-consumers.md`; ordinary Channel lists and poll detail remain own/shared, Event lists remain empty, and overlays do not gain foreign incentives. The bare Tiltify payload is unchanged, but an unqualified "no consumer change" claim is false for this case. Verify cold and warm hydration, allocation values and repeat-update claim preservation using pinned producer/consumer revisions before release. Unit/wire tests or prewarmed caches are not combined runtime acceptance.

## Delivery guarantees

- **Transactional outbox.** A message is queued in the same database transaction as the change that caused it. If the change rolls back, no message is sent. If it commits, the message cannot be lost.
- **Sent immediately.** A commit wakes the dispatcher for the Destinations that received the message. A 5 s timer is only a safety net.
- **FIFO per Destination.** Messages go out in `seq` order. If the oldest waiting message cannot be sent, the Destination **stops and waits**. A later message never overtakes an earlier one. Each Destination has its own queue, so a failing Destination never delays another.
- **At-least-once.** A consumer can receive the same message more than once, for example after a retry or a requeue. Deduplicate on the message id: the AMQP `messageId`, or the envelope `id` of a native payload. The `X-Webhook-Delivery` / `x-webhook-delivery` value identifies one Destination's copy of the message.
- **RabbitMQ "success" means the broker accepted the message**, not that a consumer processed it.
- **PII-safe payloads.** Serializers use an explicit allowlist. Donor email is never sent.

Design and rationale: [ADR-0007](adr/0007-webhook-delivery-semantics.md). It supersedes the delivery sections of [ADR-0005](adr/0005-outbound-webhooks.md).

## Runbook

### Two kinds of failure

| Kind         | What it is                                                                                                                                                                                                        | What the queue does                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | Anything the endpoint or transport reports, or no answer: connection refused, DNS, TLS, timeout, any non-2xx HTTP status (**including 4xx such as 429**), AMQP errors or confirm timeout, missing RabbitMQ config | The message stays `PENDING` and is retried **forever**: after 5 s, 15 s, 60 s, 180 s, then every 180 s. The Destination waits. New messages keep queueing behind it. |
| **Message**  | A problem found without contacting the endpoint: the stored payload is empty or is not valid JSON. This happens only because of a bug.                                                                            | The message becomes `FAILED` and the queue moves on. Requeue it after the bug is fixed.                                                                              |

An outage never turns messages into `FAILED`. It shows up as messages that keep waiting, so **alerting is how you find out** (see below).

### A Destination is stalled

**Symptoms:**

- The `WebhookQueueStalled` alert fires.
- In `/admin/destinations` → delivery log, the oldest `PENDING` row has a rising attempt count and a `last_status_code` or `last_error`.

**Steps:**

1. Read the head row's `last_status_code` / `last_error`:
   - `0` with a network error: the endpoint or broker is unreachable.
   - `401`/`403`: the credentials are wrong.
   - `404`: the URL is wrong.
   - `429`: the endpoint is rate-limiting you.
   - `RabbitMQ destination missing …`: the configuration is incomplete.
2. Fix the endpoint or the Destination's configuration. You need to do nothing else: the next retry sends the head, and the backlog follows in order.
3. To pause delivery while you fix something, set the Destination **inactive**. The stall alert ignores paused Destinations. Its waiting messages are kept and delivery resumes when you set it active again. While it is inactive, new messages are **not** queued for it.

### A message FAILED

**Symptom:** the `WebhookMessageFailed` alert fires. A row is `FAILED` with a `last_error`, for example `payload is empty (never built)` or `payload build failed: …`.

**Steps:**

1. It is a bug. Report it with the `last_error` text.
2. After the fix is deployed, requeue it. Use the **Requeue** button on the row, or **Requeue all failed** on the Destination. Through the API:
   - `POST /api/admin/destinations/:id/deliveries/:deliveryId/requeue`
   - `POST /api/admin/destinations/:id/requeue-failed`

   A requeued message keeps its original `seq`. It is sent next, so it arrives **after** later messages that already succeeded. Consumers deduplicate and upsert by id, so this is safe.

3. You cannot requeue a row whose payload was never built (HTTP 409). Nothing exists to resend.

### Recovery after an outage

When the endpoint comes back, the whole backlog is sent **in order**, as fast as the endpoint accepts it. Expect a burst of messages. Overlays such as esa-layouts-v2 play an alert for each backlogged donation. There is no purge: one Destination can feed several consumers, and a purge would lose donations for all of them.

### Retention

A sweep every 60 s deletes:

- `SUCCESS` rows older than **2 hours**;
- `FAILED` rows older than **24 hours**.

**`PENDING` rows are never deleted.**

A message that was delivered and then lost by the consumer **cannot be resent after its row is deleted**. Neither can a `FAILED` row older than 24 h. The donations themselves remain in the database. Until a reconciliation endpoint exists (#118), the only recovery is a manual database export.

### Metrics and alerts

These gauges are on `/api/metrics`. They come from the database and refresh every `METRICS_REFRESH_MS` (default 45 s). Each is labelled `destination_id` and `destination_type`.

| Metric                                                    | Meaning                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `dono_webhook_queue_depth`                                | `PENDING` messages                                                                                     |
| `dono_webhook_queue_oldest_pending_age_seconds`           | Age of the oldest `PENDING` message (0 if none)                                                        |
| `dono_webhook_queue_failed`                               | `FAILED` messages still retained                                                                       |
| `dono_webhook_destination_active`                         | `1` if the Destination is active, `0` if paused. The stall alert uses it to ignore paused Destinations |
| `dono_webhook_destination_last_success_timestamp_seconds` | Unix time of the last successful delivery that is still retained                                       |

Reference alert rules. They are deployed from `esamarathon/esa-observability`. This copy is for reference only:

```yaml
- alert: WebhookQueueStalled
  expr: >
    dono_webhook_queue_depth > 0
    and dono_webhook_queue_oldest_pending_age_seconds > 300
    and on (destination_id) dono_webhook_destination_active == 1
  for: 1m
- alert: WebhookMessageFailed
  expr: dono_webhook_queue_failed > 0
```

A 5-minute threshold is well above normal latency. A healthy queue drains in under a second, and even a message that has been retried at the 180 s ceiling stays under 5 minutes. There is no rule on last-success age alone, because an idle Destination would fire it.
