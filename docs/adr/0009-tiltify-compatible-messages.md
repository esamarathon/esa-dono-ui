# ADR-0009: Tiltify-Compatible Webhook Messages

**Date:** 2026-09-29

**Status:** Accepted

**Related:** PRD-0002 §T, §N, esamarathon/esa-dono-ui#116, ADR-0007 (delivery), ADR-0008 (identity), esamarathon/kollekt#35, esamarathon/kollekt#36, esamarathon/esa-layouts-v2#5, esamarathon/esa-layouts-v2#6

## Context

ESA's two stream consumers were built for Tiltify and read the RabbitMQ `tiltify` topic exchange:

- **kollekt** (`esamarathon/kollekt@524f276`) binds `*.donation`, calls `Guid.Parse` on every id, reads `amount.value` with `decimal.Parse`, reads `reward_claims[]` and the scalar `poll_id` / `poll_option_id` / `target_id`, and runs with `autoAck`: a body it cannot parse is dropped without trace.
- **esa-layouts-v2** (`esamarathon/esa-layouts-v2@1c8ea49`) binds `<slug>.donation` and `<slug>.fact.updated`. It adds a donation only when `completed_at` is present, ignores one with an empty `donor_name`, and **removes** a known donation whose `donor_name` is `"Anonymous"`.

Both expect **bare Tiltify-v5 objects**: the top level is the donation, with no envelope. Our native format (`{ id, type, created_at, data }`, ADR-0005) matches neither. Changing the consumers first would mean a coordinated release of three repositories before a marathon. Emulating the format means we ship alone.

## Decision

1. **A Destination has a `payload_format`**: `NATIVE` (default, unchanged) or `TILTIFY`.
   - `TILTIFY` requires `destination_type = RABBITMQ`, and the API returns 400 otherwise. No consumer reads a bare Tiltify body over HTTP, and real Tiltify HTTP webhooks use a signed `{meta, data}` envelope that this body does not have.
   - A `TILTIFY` Destination ignores `event_types` and `amqp_routing_key`. It receives exactly the messages below, and each message carries its own routing key (`WebhookDelivery.routing_key`).
   - The exchange defaults to `tiltify`. It is asserted as `topic, { durable: true, autoDelete: true }` once per connection, which are the same arguments both consumers use. A mismatch returns `PRECONDITION_FAILED`, an endpoint failure that is retried (ADR-0007), not a silent publish into the wrong exchange type.
2. **Two messages**, built in `server/services/webhooks/tiltifyPayload.ts` from the database inside the emitting transaction:
   - **Donation**, key `<channel-slug>.donation`, fields as in PRD-0002 §T4.
     - All ids are UUIDs (ADR-0008).
     - `amount.value` is a string with two decimals, and `currency` is `STRIPE_CURRENCY` upper-cased.
     - `donor_name` is the display name or `"Anonymous"`, never empty.
     - `campaign_id` is the Channel id, and `team_event_id` is the Event id.
     - The scalar incentive fields carry the first item, because kollekt reads them today. The arrays (`reward_claims`, `poll_votes`, `target_contributions`) carry the full set, for kollekt#35. An array in a scalar field would break kollekt's deserializer and lose the whole donation.
     - `reward_claims[].id` is a real `RewardClaim.id`: claims are linked to the donation that paid for them (`RewardClaim.donation_id`).
   - **Totals**, key `<slug>.fact.updated`, `{ id, slug, name, total_amount_raised }`, one for the Channel and one for its Event. Consumers match a total on `id`, so one message cannot carry both.
3. **When they are sent**, always through `withWebhooks` (`tiltify.donation(id)`, `tiltify.totals(channelId)`):

   | Change                                | TILTIFY messages                                           | NATIVE message       |
   | ------------------------------------- | ---------------------------------------------------------- | -------------------- |
   | Donation created (routed)             | donation, Channel total, Event total                       | `donation.created`   |
   | Unassigned donation assigned          | donation, Channel total, Event total                       | `donation.created`   |
   | Donation created unassigned           | nothing                                                    | nothing              |
   | Status change (refund, chargeback, …) | Channel total, Event total                                 | nothing              |
   | Hidden from overlay                   | donation as `"Anonymous"`, comment null, no `completed_at` | `donation.hidden`    |
   | Shown again                           | full donation                                              | `donation.unhidden`  |
   | `moderated` review toggle             | nothing                                                    | `donation.moderated` |
   | Incentive changes                     | nothing                                                    | `incentive.*`        |
   - **Hiding** exploits the esa-layouts-v2 removal branch: an overlay that shows the donation removes it, and one that never saw it does not add it, because there is no `completed_at`. kollekt upserts by id and shows `"Anonymous"`.
   - **Showing again** republishes the full donation. The overlay re-adds it **and plays the alert again**, so the moderator UI asks for confirmation.
   - **The `moderated` toggle does not republish**, because the body would not change. A republish of an anonymous donation would also remove it from the overlay (see Consequences).
   - **Refunds.** ESA refunds only to the donor's wallet, never to the payment method, so a refunded donation is still money the charity holds. Money totals count `COMPLETED` and `REFUNDED` (`lib/donationTotals.ts`). A refund therefore changes no total, and a chargeback lowers it. Every status change republishes the totals: they are recomputed, so an unchanged total is harmless.

4. **Native additions** (§N2), kept minimal:
   - `donation.created` gains `event_id`, `donor_name`, `donor_comment` and `hidden_from_overlay`. Name and comment are public display data and are null while the donation is hidden.
   - New message types: `donation.hidden` and `donation.unhidden`.
   - Donor email and the moderator's identity stay forbidden.

## Consequences

- **We ship without the consumers.** kollekt and esa-layouts-v2 run unchanged against a `TILTIFY` Destination. The checklists are esamarathon/kollekt#36 and esamarathon/esa-layouts-v2#6.
- **`"Anonymous"` is overloaded.** It is our name for a donor without a display name, and also the overlay's removal signal. After any republish, an anonymous donation leaves the overlay. The republishes are hide, un-hide, and a requeue by an admin. The durable fix is an explicit `hidden` field in esa-layouts-v2 (esa-layouts-v2#5).
- **"Success" means the broker accepted the message** (ADR-0007). kollekt runs `autoAck`, so a message it cannot parse is lost on its side. The golden contract tests (`server/test/services/webhooks/tiltify.test.ts`) are the guard: they assert every property the consumers parse.
- **The totals are recomputed**, not incremented. A lost or duplicated totals message corrects itself on the next one.
- **Incentives are not pushed** to `TILTIFY` Destinations. Consumers fetch them from the REST API (PRD-0002 §R, #117).

## Alternatives considered

- **Change the consumers to read the native envelope.** Rejected: it needs a coordinated release of three repositories, and it breaks every Tiltify-era deployment of the consumers.
- **A separate `hidden` field instead of the `"Anonymous"` convention.** Deferred to esa-layouts-v2#5. Today's overlay would ignore it.
- **Tiltify format over HTTP.** Rejected (see Decision 1).
