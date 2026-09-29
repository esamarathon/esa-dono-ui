# PRD: Outbound Webhook Queue and Tiltify-Compatible Messages

Triage: `ready-for-agent` (per child issue — see "Work Breakdown")
Origin: esamarathon/esa-dono-ui#109 ("Message Queue Review")
Related: `docs/adr/0005-outbound-webhooks.md` (partly superseded — see "ADR Conflicts"),
`docs/prd/0001-tiltify-to-stripe-migration.md`

## Problem Statement

ESA replaced Tiltify with its own donation system. Three downstream systems still expect
Tiltify: **kollekt** (the main consumer — donation reading and incentive tracking),
**esa-layouts-v2** (stream overlays: donation bar, alert sound, totals), and indirectly the
old **ESATiltifyBridge**, which used to put Tiltify webhooks onto RabbitMQ.

Issue #109 asked three things of the outbound message queue:

1. The outbound data structure must match Tiltify output.
2. The queue must keep FIFO order.
3. The worker must send immediately, not on a timer.

A review found that none of the three is true today:

- **FIFO is broken.** `processDestination()` selects the head with
  `next_attempt_at: { lte: now() }`, so a head that is backing off is skipped and the next
  message is sent before it. ADR-0005 claims the opposite.
- **Sending is on a timer.** One message per destination per 15 s tick: a ceiling of
  4 messages per minute per destination and ~7.5 s median latency.
- **No single-flight guard.** Overlapping async ticks can send the same row twice or reorder.
- **The outbox is not atomic.** `emitWebhookEvent()` is fire-and-forget after the
  donation transaction commits, and `nextSeq()` runs in its own transaction, so `seq`
  follows callback scheduling, not commit order.
- **AMQP publish has no timeout** and the cached connection has no `error`/`close` handler.
- **The payload is not Tiltify-shaped**, and every id is a cuid. kollekt calls `Guid.Parse`
  on ids; a cuid throws, and because kollekt runs `autoAck: true` with a log-only catch, the
  donation is **acknowledged and lost** with no trace on either side.
- **No retention**, no requeue, no metrics for the queue.

Fixing only the three #109 requirements would produce a correct queue that delivers
messages every consumer drops. This PRD covers the whole path from a donation to a working
consumer.

## Solution

1. Make the queue a correct, per-destination FIFO outbox that sends as soon as a message
   is committed, stalls on endpoint failure instead of skipping, and never loses a message
   because an endpoint is down.
2. Add a per-destination **payload format**: `TILTIFY` (bare Tiltify-v5 donation and
   campaign objects on the `tiltify` topic exchange, exactly what kollekt and
   esa-layouts-v2 consume) and `NATIVE` (the existing envelope, kept for future use).
3. Switch every id to UUID, and add an **Event** model as the parent of **Channel**, both
   with URL- and routing-safe **slugs**.
4. Serve a Tiltify-compatible REST API, because both consumers fetch incentive data from
   `app.esamarathon.com/tiltify` instead of reading it from the message.
5. Separate the vocabulary of a charity **Event** from a **webhook message**, in code and
   documentation, so developers and agents stop confusing them.

## Glossary

| Term                | Means                                                                       | Avoid                             |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------- |
| **Event**           | A charity event: a marathon, or a one-day stream event. Parent of Channels. | occasion, campaign, team campaign |
| **Channel**         | One stream within an Event.                                                 | stream, campaign                  |
| **Primary channel** | The Channel an Event routes to when a donation names no Channel.            | default channel                   |
| **Webhook message** | One outbound notification about something that happened.                    | event, webhook event              |
| **Destination**     | Where webhook messages go (HTTP URL or RabbitMQ exchange).                  | endpoint, event destination       |
| **Delivery**        | One queued attempt to send one webhook message to one Destination.          | job                               |
| **Slug**            | The lowercase, URL- and routing-safe name of an Event or Channel.           | handle, key                       |

Tiltify mapping (the only place we must use Tiltify's words):

| Tiltify field      | Our concept        |
| ------------------ | ------------------ |
| `team_event_id`    | `Event.id`         |
| `campaign_id`      | `Channel.id`       |
| team campaign slug | `Event.slug`       |
| campaign slug      | `Channel.slug`     |
| `target_id`        | `FundGoal.id`      |
| `reward_claims[]`  | `RewardClaim` rows |

"Avoid" is guidance, not a ban. The wire keeps `X-Webhook-Event`, the AMQP header
`x-webhook-event`, the admin API field `event_types`, and native `type` values such as
`donation.created`: those are external contracts, and "webhook event" is the industry term.

## User Stories

1. As a kollekt reader, I want every donation to arrive with parseable UUIDs and a
   Tiltify-shaped body, so that no donation is silently dropped.
2. As a stream producer, I want a donation to appear on the overlay within a second of
   payment, so that the alert matches what the host sees.
3. As a stream producer, I want donations to appear in the order they were made, so that
   the host reads them in context.
4. As a moderator, I want to hide a donation from the overlay, so that an abusive name or
   comment leaves the stream immediately.
5. As an admin, I want messages to wait while a destination is down and flow again when it
   recovers, so that an outage never loses a donation.
6. As an admin, I want an alert when a destination stops accepting messages, so that I
   find out before the overlay goes stale.
7. As an admin, I want to requeue a failed message after a fix, so that a bug does not
   permanently lose it.
8. As an admin, I want to create Events and Channels with friendly slugs, so that donate
   links such as `/donate/esa-summer-2025/stream-1` are readable and consumers bind to
   predictable routing keys.
9. As a developer or AI agent, I want "Event" to mean one thing in the code, so that I do
   not modify webhook plumbing when I meant the charity event, or the reverse.

## Implementation Decisions

Numbered so issues and reviews can cite them (`PRD-0002 §Q3`).

### §V — Vocabulary split

- **V1.** Rename Prisma models `EventDestination` → `WebhookDestination`,
  `EventDestinationSeq` → `WebhookDestinationSeq`, `EventDelivery` → `WebhookDelivery`.
  Keep `@@map("WebhookEndpoint")`, `@@map("WebhookEndpointSeq")`,
  `@@map("WebhookDelivery")`. **No SQL change.**
- **V2.** Rename field `event_type` → `message_type` with `@map("event_type")`.
  **No SQL change.**
- **V3.** Rename code identifiers: `emitWebhookEvent` → `emitWebhookMessage`,
  `WebhookEventType` → `WebhookMessageType`, `startEventDispatcher` →
  `startWebhookDispatcher`. Move `server/services/eventDelivery.ts` and
  `server/services/eventDispatcher.ts` into `server/services/webhooks/`.
- **V4.** Do not change the wire: headers, admin API field names, routes, native `type`
  values (see Glossary).
- **V5.** Add a **warn-level** ESLint rule that flags new `Event`-named identifiers under
  `server/services/webhooks/`. It must not fail CI.

### §Q — Queue semantics (#109)

- **Q1. Ordering.** FIFO per Destination by `seq`. The head is the lowest-`seq` `PENDING`
  row, selected **without** a `next_attempt_at` filter. If the head is not due, the
  Destination stalls; later rows never overtake it.
- **Q2. Failure classes.** Classify by _where the failure is detected_:

  | Class                                                                 | Examples                                                                                                                         | Result                                                    |
  | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
  | **Message** — detectable without contacting the endpoint              | payload builder throws, stored payload unparseable, required slug/uuid missing                                                   | `FAILED` at once; queue moves on                          |
  | **Endpoint** — anything the endpoint or transport reports, or silence | connection refused, DNS, TLS, timeout, confirm timeout, channel closed, `PRECONDITION_FAILED`, **any HTTP status including 4xx** | retry **forever**; head stays; new messages keep queueing |

  All HTTP 4xx are endpoint failures on purpose: a consumer bug that returns 400 must not
  mark our queue `FAILED` and skip it.

  A builder failure at emit time must **not** throw inside the donation transaction
  (that would roll back the donation). It inserts the row as `FAILED` with an empty
  payload and the error in `last_error`. Active Events and Channels always have slugs
  (§S6, §S8), so this is reachable only through a bug.

- **Q3. Backoff** for endpoint failures: 5 s, 15 s, 60 s, 180 s, then 180 s repeated.
  `attempts` and `last_error` update on every try. Remove `max_attempts` (unused).
- **Q4. Immediacy.** `emitWebhookMessage(tx, …)` inserts deliveries inside the caller's
  transaction. Callers use one helper, `withWebhooks(fn)`, which runs
  `prisma.$transaction(fn)` and calls `wakeDispatcher()` after commit, so no call site
  can forget the wake. A 5 s interval is a safety net only.
- **Q5. Drain.** A woken Destination sends until its queue is empty or its head fails.
- **Q6. Single-flight.** Module-level `Set<destinationId>` of in-flight drains, plus a
  "run again" flag so a wake during a drain is not lost. One process only; multi-process
  leasing is out of scope.
- **Q7. Transactional outbox.** `seq` allocation and delivery insert run in the same
  transaction as the donation/moderation change that caused them. A rollback removes the
  message. SQLite serialises writers, so commit order equals `seq` order. All 16
  production emit sites move to `withWebhooks`: `services/donation.ts:165`,
  `services/pledge.ts:512`, `routes/moderator.ts:583`, and 13 in `routes/admin.ts`
  (incentive create/update/enable/disable). No fire-and-forget emit remains.
- **Q8. AMQP.** Publisher confirms with a 10 s timeout; 30 s heartbeat; `error` and
  `close` handlers evict the cached connection. `SUCCESS` means _broker accepted_, not
  _consumer processed_. No `mandatory` flag.
- **Q9. Message identity.** Add `WebhookDelivery.message_id`: one UUID per webhook message,
  shared by every Destination's row for that message and stable across retries. A donation
  that produces a donation message and two totals messages has three `message_id`s. Sent
  as AMQP `messageId`; the headers `x-webhook-event` (message type) and
  `x-webhook-delivery` (row id) stay.
- **Q10. Retention.** A sweep every 60 s deletes `SUCCESS` rows older than 2 h and
  `FAILED` rows older than 24 h (by `updated_at`). **`PENDING` rows are never deleted.**
  Add an index on `(status, updated_at)`.
- **Q11. Requeue** (admin only):
  `POST /api/admin/destinations/:id/deliveries/:deliveryId/requeue` and
  `POST /api/admin/destinations/:id/requeue-failed` set `FAILED` → `PENDING`,
  `attempts: 0`, keep the original `seq`, and wake the dispatcher. A row whose payload was
  never built returns 409. A requeued row is sent next, so it arrives after later
  messages that already succeeded; consumers upsert by id, so this is safe.
- **Q12. Inactive destinations.** Emit skips inactive Destinations (unchanged). Existing
  `PENDING` rows stay and resume on reactivation.
- **Q13. Recovery flush.** After an outage the backlog is sent in order. esa-layouts-v2
  plays an alert per backlogged donation; this is documented, and alert suppression by age
  is raised upstream (esa-layouts-v2#5). No purge action, because one Destination can feed
  several consumers.

### §M — Metrics and alerting

- **M1.** New gauges, labelled `destination_id` and `destination_type`, refreshed on the
  existing `METRICS_REFRESH_MS` (45 s) cycle, sourced from the database:
  `dono_webhook_queue_depth`, `dono_webhook_queue_oldest_pending_age_seconds`,
  `dono_webhook_queue_failed`, `dono_webhook_destination_last_success_timestamp_seconds`, and `dono_webhook_destination_active` (0/1, so the stall alert ignores paused Destinations).
- **M2.** `dono_donations_unassigned` (see §E6).
- **M3.** Per-Event and per-Channel breakdowns, as separate gauges labelled `event` and
  `channel` (slug values; empty string when unassigned or shared):
  `dono_donated_cents_by_channel`, `dono_donations_by_channel`,
  `dono_reward_claims_by_channel`, `dono_poll_votes_by_channel`. The unlabelled global
  gauges (`dono_donated_cents_total`, …) are unchanged. _Implementation note (#115):_
  labels were not added to the existing gauges themselves, because a gauge that has both
  an unlabelled total and labelled parts double-counts under PromQL `sum()`.
- **M4.** Reference alert rules (deployed from `esamarathon/esa-observability`). No rule
  on last-success age alone: an idle Destination would alert.

  ```yaml
  - alert: WebhookQueueStalled
    expr: >
      dono_webhook_queue_depth > 0
      and dono_webhook_queue_oldest_pending_age_seconds > 300
      and on (destination_id) dono_webhook_destination_active == 1
    for: 1m
  - alert: WebhookMessageFailed
    expr: dono_webhook_queue_failed > 0
  - alert: DonationsUnassigned
    expr: dono_donations_unassigned > 0
    for: 5m
  ```

### §S — Schema, identity and slugs

- **S1.** Every `@default(cuid())` becomes `@default(uuid())`. There is no production;
  dev and staging data are reset. No backfill.
- **S2.** New model `Event`: `id` (uuid), `name`, `slug` (unique), `is_active`,
  `primary_channel_id` (nullable FK to `Channel`), timestamps.
- **S3.** `Channel` gains `slug` (unique) and `event_id` (required FK to `Event`).
- **S4.** `Donation` gains `event_id` (nullable FK) and `hidden_from_overlay`
  (`Boolean @default(false)`).
- **S5.** `WebhookDestination` gains `payload_format` (`TILTIFY` | `NATIVE`, default
  `NATIVE`). `WebhookDelivery` gains `routing_key` (nullable).
  (`message_id`, the `(status, updated_at)` index and the `max_attempts` removal belong
  to Issue 2, which lands first.)
- **S6. Slug rules.** `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–64 characters, not in a reserved list
  (route names such as `admin`, `api`, `donate`, `wallet`), unique across Event **and**
  Channel (checked in application code). No `.`: it is the AMQP topic separator, and
  kollekt binds `*.donation`, where `*` matches exactly one word.
- **S7.** A slug cannot change while its Event/Channel is active. No alias table in v1.
- **S8. Primary channel.** An Event cannot be activated without a `primary_channel_id`
  that is an active Channel of the same Event. Deactivating the primary Channel of an
  active Event returns 409 until another is designated.
- **S9.** `server/prisma/seed.ts` creates one active Event with one active primary
  Channel, so the dev stack, `scripts/smoke-test.sh` and `server/scripts/simulator/` route
  donations without extra setup. Both scripts are updated for the new fields.

### §E — Event API, routing and URLs

- **E1.** Admin CRUD `/api/admin/events`, mirrored at `/api/moderator/events`; public
  `GET /api/events` and `GET /api/events/:slug`. Deleting deactivates.
- **E2.** Channel responses include `slug` and `event_id` everywhere they appear.
- **E3.** Donate URLs: `/donate/<event-slug>` and `/donate/<event-slug>/<channel-slug>`
  preselect the Event and Channel. `/donate` keeps its picker.
- **E4.** `POST /api/pledge` keeps requiring `channel_id`; the pledge's Event is derived
  from the Channel.
- **E5. Donation routing** (resolved when the donation is created):
  1. explicit `channel_id` → that Channel;
  2. else Event known → the Event's primary Channel;
  3. else exactly one active Event → its primary Channel;
  4. else → store unassigned (`channel_id` and `event_id` null), publish nothing.

  "Event known" means the caller passed `event_id` (for example
  `simulate-donation`). `POST /api/admin/simulate-donation` accepts optional `channel_id`
  or `event_id` and follows the same four steps, so existing scripts keep working.

- **E6.** Unassigned donations appear in the admin UI, are counted by
  `dono_donations_unassigned`, and an admin assigns them with
  `PATCH /api/admin/donations/:id/channel`. Assignment publishes the donation message and
  both totals messages. The donation keeps its original `completed_at`, so esa-layouts-v2
  adds it to the bar and plays the alert at assignment time.
- **E7.** Totals count `COMPLETED` and `REFUNDED` donations, hidden donations
  included. ESA never refunds to the original payment method, only to the donor's
  wallet, so a refunded donation is still money the charity holds. `CHARGEBACK` (the
  bank took the money back) and `PENDING` (not paid) do not count. `/api/campaign`,
  admin stats and the cents metrics share one rule (`server/lib/donationTotals.ts`).

### §T — Tiltify message format

- **T1.** `TILTIFY` requires `destination_type = RABBITMQ`; HTTP + `TILTIFY` returns 400.
  (No consumer reads a bare Tiltify body over HTTP, and real Tiltify HTTP webhooks use a
  signed `{meta, data}` envelope this body does not have.)
- **T2.** Exchange from the Destination's `amqp_exchange` (normally `tiltify`), asserted
  `topic, { durable: true, autoDelete: true }` — the same arguments both consumers assert,
  or the broker returns `PRECONDITION_FAILED`. Properties: `contentType: application/json`,
  `persistent: true`, `messageId` = `message_id`.
- **T3.** A `TILTIFY` Destination ignores `event_types` and `amqp_routing_key`. It
  receives exactly the messages in T4–T7, with a computed routing key.
- **T4. Donation message**, key `<channel-slug>.donation`, **bare object, no envelope**:

  | Field                        | Value                                                                                                                                                                                                          |
  | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `id`                         | `Donation.id` (uuid)                                                                                                                                                                                           |
  | `amount`                     | `{ "currency": "USD", "value": "82.95", "value_cents": 8295 }` — `value` is a **string** with two decimals; `currency` is `STRIPE_CURRENCY` upper-cased (default `USD`)                                        |
  | `donor_name`                 | display name, or `"Anonymous"`                                                                                                                                                                                 |
  | `donor_comment`              | comment, or `null`                                                                                                                                                                                             |
  | `created_at`, `completed_at` | ISO-8601 UTC strings                                                                                                                                                                                           |
  | `campaign_id`                | `Channel.id`                                                                                                                                                                                                   |
  | `team_event_id`              | `Event.id`                                                                                                                                                                                                     |
  | `reward_id`                  | first reward, or `null`                                                                                                                                                                                        |
  | `reward_claims`              | `[{ id, reward_id, quantity: 1, custom_question }]` — one per `RewardClaim` row (one row per unit); `custom_question` = the raw `claim_data` string, or `null`. It is donor free text shown to kollekt readers |
  | `poll_id`, `poll_option_id`  | first poll vote, or `null`                                                                                                                                                                                     |
  | `poll_votes`                 | `[{ poll_id, poll_option_id }]` — full set                                                                                                                                                                     |
  | `target_id`                  | first goal contribution, or `null`                                                                                                                                                                             |
  | `target_contributions`       | `[{ target_id, amount }]` — full set                                                                                                                                                                           |

  Omitted: `cause_id`, `fundraising_event_id`, `legacy_id`, `sustained` (no analogue).
  `POLL_CUSTOM` items are omitted until approved (no option id exists). Scalars carry the
  first item because kollekt reads them today; the arrays are for kollekt's update
  (see Work Breakdown). Sending an array in a scalar field would break kollekt's
  deserializer and drop the whole donation.

- **T5. Hide.** Moderators set it with the existing
  `PATCH /api/moderator/donations/:id`, extended to accept `{ hidden_from_overlay }`
  (independent of `moderated`); `ModeratorDonations` gets Hide / Un-hide controls. When
  `hidden_from_overlay` becomes true, republish with
  `donor_name: "Anonymous"`, `donor_comment: null`, and **`completed_at` omitted**.
  esa-layouts-v2 removes a known donation named `Anonymous`, and its add branch requires
  `completed_at`, so an overlay that never saw the donation stays silent. kollekt upserts
  by id and shows `Anonymous`.
- **T6. Un-hide** republishes the full object. esa-layouts-v2 re-adds it **and plays the
  alert**; the admin UI warns before confirming.
- **T7. Totals message**, key `<slug>.fact.updated`, body
  `{ id, slug, name, total_amount_raised: { currency, value } }`. Published for the
  Channel **and** its Event whenever a total changes: donation created or assigned, and a status change that
  moves the donation into or out of the counted statuses (§E7). A chargeback lowers the
  total and publishes; a refund goes to the donor's wallet, changes no total, and
  publishes nothing. Consumers match on `id`, so one message cannot carry both totals.
- **T8.** The `moderated` review toggle does **not** republish on `TILTIFY`: the body does
  not change, and a republish of an anonymous donation would remove it from the overlay.
- **T9.** `"Anonymous"` is our convention for donors with no display name. Consequence:
  an anonymous donation leaves the overlay after any republish. Documented; the durable
  fix is esa-layouts-v2#5.
- **T10.** Incentive messages are not sent to `TILTIFY` Destinations; consumers fetch
  incentives from the REST API (§R).

### §N — Native format

- **N1.** `NATIVE` keeps the current envelope `{ id, type, created_at, data }` and all six
  types. It is the default, so existing destinations do not change behaviour.
- **N2.** Minimal additions: `event_id` on `donation.created`; `donor_name` and
  `donor_comment` on `donation.created` (public display data; email stays forbidden);
  new types `donation.hidden` and `donation.unhidden` (added to the destination form's
  type list); `channel_id` on incentive types.
  `donation.moderated` is unchanged. The PII test changes to forbid `email`,
  `donor_email`, `moderated_by`.
- **N3.** No redesign until a consumer needs it.

### §R — Tiltify-compatible REST API

Both consumers read incentive data from `app.esamarathon.com/tiltify` (layouts:
`tiltify.api.url`; kollekt: `TiltifyBridge.Url`). This system must serve the union of
their routes: `campaigns/{id}` (an Event **or** Channel uuid — layouts calls it with the
team id), `campaign/{id}/rewards|targets|milestones|polls|matches`,
`campaign/{id}/polls/{poll_id}`. `matches` returns an empty list. Response shapes, auth and
shared-incentive handling are specified in their own issue. Until it ships, **kollekt
cannot consume our messages**: an unknown campaign id makes it throw and drop the donation.

## Testing Decisions

- Dispatcher tests replace the minute backoff assertion (1/2/4/8/60) with 5/15/60/180/180 s
  and add: head-stall (a due `seq+1` is not sent while `seq` backs off), drain-until-empty,
  single-flight (two concurrent wakes send once), message-class `FAILED` moves on,
  endpoint-class never becomes `FAILED`, retention never deletes `PENDING`.
- Outbox tests: a rolled-back donation creates no delivery; `seq` follows commit order.
- Tiltify contract tests: golden fixtures asserting every field each consumer reads
  (`id`/`campaign_id`/`team_event_id` parse as UUIDs, `amount.value` is a string,
  `donor_name` is non-empty, `completed_at` present except on hide, bare object).
- Slug validation tests, primary-channel activation tests, routing-resolution tests (E5).
- `server/test/openapi-coverage.test.ts` must pass for every new route.
- Run via `npm run typecheck` and `npm test` from the repo root.

## Work Breakdown

| #   | Issue                                                           | GitHub | Depends on                         |
| --- | --------------------------------------------------------------- | ------ | ---------------------------------- |
| 1   | Vocabulary split (§V)                                           | #113   | —                                  |
| 2   | Queue correctness (§Q, §M1, §M4)                                | #109   | #113                               |
| 3   | UUIDs, Event model, slugs, primary channel (§S)                 | #114   | #109                               |
| 4   | Event API, routing, friendly URLs, labelled metrics (§E, §M2–3) | #115   | #114                               |
| 5   | Tiltify message format and native additions (§T, §N)            | #116   | #115                               |
| 6   | Tiltify-compatible REST API (§R)                                | #117   | #116 (design may start after #114) |
| 7   | Reconciliation read endpoint (deferred)                         | #118   | #114                               |
| 8   | Documentation consistency review                                | #119   | #113–#117                          |

Epic: #112.

**Conflict rule.** Issues 1–5 edit `schema.prisma`, the webhook services, or both, so
they land **one at a time, in order**, each rebased on the previous merge. Only one
migration is open at any time. Issue 6 is design-first: its issue specifies response
shapes before any code, and it lands after Issue 5 because it shares `server/index.ts`
route mounting and `server/openapi.yaml`.

External (consumer and ops repositories):

| Repository        | Issue                           | Change                                                                                                                | Kind                 |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| kollekt           | esamarathon/kollekt#36          | Migration checklist: `Rabbit:Enabled`/`Url`, `TiltifyBridge:Url` → #117 (hard dependency), dead-letter recommendation | Config + recommended |
| kollekt           | esamarathon/kollekt#35          | Accept `poll_votes` / `target_contributions` arrays or scalars                                                        | Code                 |
| esa-layouts-v2    | esamarathon/esa-layouts-v2#6    | Migration checklist: `teamCampaign` = Event, `campaigns[]` = Channels, `rabbitmq.url`, `tiltify.api.url` → #117       | Config               |
| esa-layouts-v2    | esamarathon/esa-layouts-v2#5    | Explicit removal field; alert suppression by age                                                                      | Code (discussion)    |
| esa-observability | esamarathon/esa-observability#1 | Deploy §M4 alert rules                                                                                                | Ops                  |

Switch order for consumers: deploy #117, then point each consumer's REST base URL at it, then
its RabbitMQ URL. Switching RabbitMQ first makes kollekt drop every donation.

Every issue carries its own documentation acceptance criteria (see the owner column
below). Issue 8 is the final consistency review.

## Documentation Requirements

Each document has **one owning issue**, so two changes never write the same section.
Issue 8 reviews the whole set for consistency but writes only what is listed for it.

| Audience           | Document                                             | Section / change                                                                                               | Owner   |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| Agents             | `CONTEXT.md` (new)                                   | Create: glossary (Event, Channel, Webhook message, Destination, Delivery) and "avoid" column                   | 1       |
| Agents             | `CONTEXT.md`                                         | Add: Slug, Primary channel                                                                                     | 3       |
| Agents             | `CONTEXT.md`                                         | Add: Tiltify mapping table                                                                                     | 5       |
| Agents             | `CLAUDE.md`                                          | Webhook bullets → new names; "avoid" vocabulary guidance for agents                                            | 1       |
| Agents             | `CLAUDE.md`                                          | Queue semantics, requeue, retention, metrics                                                                   | 2       |
| Agents             | `CLAUDE.md`                                          | Rewrite stale "Events" section (describes a model deleted in `45e74f5`); UUIDs; slugs                          | 3       |
| Agents             | `CLAUDE.md`                                          | Event API, routing, URLs, env/metrics tables                                                                   | 4       |
| Agents             | `CLAUDE.md`                                          | Payload formats                                                                                                | 5       |
| Agents + humans    | `docs/adr/0006-webhook-vocabulary.md`                | Why Event ≠ webhook message                                                                                    | 1       |
| Agents + humans    | `docs/adr/0007-webhook-delivery-semantics.md`        | FIFO, failure classes, outbox, retention; add "Superseded in part by ADR-0007" to ADR-0005                     | 2       |
| Agents + humans    | `docs/adr/0008-event-channel-identity.md`            | Event → Channel, UUID ids, slugs, primary channel                                                              | 3       |
| Agents + humans    | `docs/adr/0009-tiltify-compatible-messages.md`       | Tiltify format, consumer contract                                                                              | 5       |
| Humans (operators) | `docs/outbound-events.md` § Runbook                  | Failure classes, requeue, retention, metrics, alert thresholds, recovery flush, "unrecoverable past retention" | 2       |
| API consumers      | `docs/outbound-events.md` § Formats                  | Both formats, routing keys, message identity, delivery guarantees                                              | 5       |
| Humans (operators) | `docs/outbound-events.md` § Consumer setup           | kollekt and esa-layouts-v2 config: slugs, uuids, exchange, REST base URL                                       | 6       |
| Humans             | `docs/simulating-donations.md`, `docs/deployment.md` | `simulate-donation` with `channel_id`/`event_id`; seed Event/Channel                                           | 3       |
| Humans (staff)     | `client/src/pages/shared/StaffHelp.tsx`              | Destinations: requeue, stalls                                                                                  | 2       |
| Humans (staff)     | `client/src/pages/shared/StaffHelp.tsx`              | Events, Channels, slugs, primary channel, unassigned donations                                                 | 4       |
| Humans (staff)     | `client/src/pages/shared/StaffHelp.tsx`              | Hide from overlay, payload format                                                                              | 5       |
| Humans (admins)    | Admin UI inline help                                 | Requeue (2); slug fields, primary channel (4); hide / un-hide warning, payload format (5)                      | 2, 4, 5 |
| API                | `server/openapi.yaml`                                | Every route each issue adds or changes, enforced by `openapi-coverage.test.ts`                                 | each    |
| All                | Consistency review                                   | Every row above agrees with the shipped code; no stale "Event" meaning webhook                                 | 8       |

## ADR Conflicts

- Contradicts **ADR-0005** on two points: it states the queue stalls on a failing head and
  that emits are atomic. Neither is true of the current code. ADR-0007 supersedes those
  sections; ADR-0005 gets a "Superseded in part by" note, not an in-place rewrite.

## Open Questions

- **Refunds and chargebacks on the donation message.** §T7 publishes only lower totals on a
  refund. The donation is not republished, so it stays readable in kollekt and stays on the
  esa-layouts-v2 donation bar. Decide whether a refund also republishes the donation (for
  example, as a hide on `TILTIFY` and a `donation.refunded` on `NATIVE`). Recorded in
  esamarathon/kollekt#36 and esamarathon/esa-layouts-v2#6. Must be decided before #116.

## Out of Scope

- Multi-process dispatch (database leasing).
- Reconciliation read endpoint (Issue 7, tracked, not built here).
- Changing wire header names.
- A native format redesign.
- Slug aliases and redirects after a rename.
- A comment review workflow beyond hide-from-overlay.

## Further Notes

- Events lost past retention cannot be recovered until Issue 7 ships. `SUCCESS` rows are
  kept only 2 h. `GET /api/admin/donations` is not a reconciliation path: it needs the
  admin key and returns donor email.
- Consumer facts in this PRD come from reading `esamarathon/kollekt@524f276`,
  `esamarathon/esa-layouts-v2@1c8ea49`, and `esamarathon/ESATiltifyBridge@a63d98f`.
