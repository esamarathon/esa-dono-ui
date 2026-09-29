# ADR-0006: Webhook Vocabulary — "Event" Means the Charity Event

**Date:** 2026-09-26

**Status:** Accepted

**Related:** PRD-0002 §V, esamarathon/esa-dono-ui#113, [ADR-0007](0007-webhook-delivery-semantics.md) (delivery), [ADR-0008](0008-event-channel-identity.md) (identity: what an Event is), [ADR-0009](0009-tiltify-compatible-messages.md) (Tiltify format)

## Context

The word "Event" named two different things in the same code:

1. **The charity event** — the domain concept. This concept has been renamed several
   times: `Stream` → `Event` (`afc5f07`) → `Channel` (`45e74f5`, commit message gives no
   reason). PRD-0002 restores `Event` as the **parent** of `Channel`: an Event is a
   marathon or a one-day stream event; a Channel is one stream within it.
2. **A webhook notification** — the Prisma models `EventDestination`,
   `EventDestinationSeq` and `EventDelivery`, the field `event_type`, and functions such as
   `emitWebhookEvent` and `startEventDispatcher`.

With both in the codebase, a developer or an AI agent searching for "event" finds both, and
a change intended for one can land in the other. The collision is the most likely reason
the domain concept was renamed away from "Event" last time.

## Decision

- "Event" in code means only the charity event.
- Webhook concepts use **Webhook** and **message**:
  - Models: `WebhookDestination`, `WebhookDestinationSeq`, `WebhookDelivery`.
  - Field: `message_type`.
  - Functions and types: `emitWebhookMessage`, `WebhookMessageType`,
    `WEBHOOK_MESSAGE_TYPES`, `startWebhookDispatcher`.
  - Modules: `server/services/webhooks/delivery.ts` and `dispatcher.ts`.
- **No database change.** The tables were already named `WebhookEndpoint`,
  `WebhookEndpointSeq` and `WebhookDelivery` through `@@map`; the column keeps its name
  through `@map("event_type")`.
- **No wire change.** `X-Webhook-Event`, `x-webhook-event`, the admin API field
  `event_types`, the delivery-log field `event_type`, and native `type` values stay. They
  are external contracts, and "webhook event" is the industry term (Stripe, GitHub), so it
  does not confuse outside consumers.
- The vocabulary is **guidance, not a ban**. `CONTEXT.md` defines the terms and lists
  words to avoid; an ESLint rule **warns** on new `Event`-named identifiers under
  `server/services/webhooks/` and never fails CI.

## Consequences

- Readers and agents can search for `Event` and find only domain code.
- The delivery-log route maps `message_type` back to `event_type` in its response, so the
  admin client is unchanged. A route test pins that contract.
- The mapping between code names and wire names is a small, documented exception rather
  than something to rediscover.

## Alternatives Considered

- **Rename the domain concept instead** (for example `Campaign` or `Marathon`). Rejected:
  "Event" is the word ESA uses for both marathons and day events, and "campaign" means a
  single stream in Tiltify's model, which every consumer uses.
- **Rename the wire too** (`X-Webhook-Message-Type`). Rejected: breaks existing HTTP
  consumers for no gain outside our own code.
- **A failing CI check on the word.** Rejected: too strict for a word with legitimate wire
  uses; a warning is enough to catch drift.
