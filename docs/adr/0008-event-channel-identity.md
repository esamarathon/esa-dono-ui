# ADR-0008: Event and Channel Identity — UUIDs, Slugs, Primary Channel

**Date:** 2026-09-28

**Status:** Accepted

**Related:** PRD-0002 §S, esamarathon/esa-dono-ui#114, ADR-0006 (vocabulary)

## Context

The consumers that read our donations were built for Tiltify:

- **kollekt**, the donation reader;
- **esa-layouts-v2**, the stream overlays.

They depend on three things we did not have:

1. **UUID ids.** kollekt calls `Guid.Parse` on every id it reads. Our cuids throw inside kollekt, which acknowledges the message and drops it without any trace.
2. **Two levels.** Tiltify has a _team campaign_ (the marathon) that contains _campaigns_ (one per stream). The overlays bind to both levels: one event-wide total, plus per-stream donations. Our only level was `Channel`. The concept was renamed `Stream` → `Event` in `afc5f07`, then `Event` → `Channel` in `45e74f5`. The second commit gives no reason.
3. **Slugs.** Consumers bind to stable, human-chosen names such as `esa-summer-2025` and `esa-summer-2025-stream-1`, used in RabbitMQ routing keys (`<slug>.donation`). ESA also wants readable donate links.

## Decision

- **Ids are UUIDs.** Every model uses `@default(uuid())`. This is a Prisma-level default and changes no SQL. Existing rows keep their ids, and dev and staging are reset.
- **Event is the parent of Channel.** Each has a `slug`.
  - `Event`: `name`, `slug`, `is_active`, `primary_channel_id`.
  - `Channel`: `slug`, and a required `event_id`.
  - "Event" means the charity event again. This is possible because ADR-0006 moved the webhook code to "message".
- **Primary channel.** An Event names one of its Channels as primary. A donation that names no Channel is routed there (the routing itself is #115). The rules:
  - An Event can be activated only when its primary Channel belongs to it and is active.
  - The primary Channel of an active Event cannot be deactivated or moved to another Event (409).
- **Slug rules** (`server/lib/slugs.ts`):
  - format `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–64 characters;
  - not a reserved route name;
  - unique across Events **and** Channels. The app checks this, because two tables cannot share one unique index.

  There is no `.`, because it is the AMQP topic separator, and kollekt's `*.donation` binding matches exactly one word. The admin API derives a slug from the name when none is given.

- **A slug is fixed while active.** It can change only while its Event or Channel is inactive. There are no alias or redirect tables in v1.
- **The migration works on a non-empty database.** It inserts a default Event (fixed id `00000000-0000-4000-8000-000000000001`, slug `default-event`, inactive) and attaches existing Channels to it. It gives them the slugs `channel-<id>` and sets `event_id` on donations that have a channel. `prisma db seed` then makes one Event active with a primary Channel.
- **Only one Event?** A Channel created without `event_id` joins the only Event. With several Events, `event_id` is required. This keeps channel creation working until the Event admin UI arrives in #115.

## Consequences

- kollekt can parse every id.
- The Event and Channel map onto Tiltify's team campaign and campaign. The payload work (#116) can fill `team_event_id` and `campaign_id` directly.
- Renaming a live stream's slug requires deactivating it first. This is deliberate: the slug is a contract with overlays and published links.
- Channels created before the migration get machine-looking slugs. On a reset database there are none.
- `Donation.event_id` and `hidden_from_overlay` are added now so that #115 and #116 do not need another table rebuild. They are unused until then.

## Alternatives Considered

- **A configured singleton event instead of a model.** Rejected: ESA runs several events a year, a marathon and one-day events, and the historical grouping of donations must survive between them.
- **Name the parent `Campaign` or `Marathon`.** Rejected: in Tiltify's vocabulary, which every consumer uses, "campaign" means a single stream, and not every event is a marathon.
- **Add a separate `uuid` column and keep cuid primary keys.** Rejected: that would mean two ids for every row, forever. With no production data, switching the default costs nothing.
- **Derive slugs automatically and never store them.** Rejected: a slug must stay stable when a display name changes, because consumers bind to it.
