# ADR-0010: Tiltify-Compatible REST API

**Date:** 2026-09-30

**Status:** Accepted

**Related:** PRD-0002 §R, esamarathon/esa-dono-ui#117 (design comment), [ADR-0008](0008-event-channel-identity.md) (identity), [ADR-0009](0009-tiltify-compatible-messages.md) (messages), esamarathon/kollekt#36, esamarathon/esa-layouts-v2#6

## Context

kollekt and esa-layouts-v2 read incentives and totals from a REST API that `ESATiltifyBridge` (`WebApi/CampaignController.cs`) served in front of Tiltify. kollekt calls `campaigns/{id}` for every campaign id it sees in a donation, and **drops the donation** when that fails ("Unknown campaign in source."). It then polls `rewards`, `targets`, `milestones` and `polls` every 5 s. layouts reads `campaigns/{id}` for totals, and `polls`, `milestones` and `matches` every 30 s. Without this API, kollekt cannot consume the Tiltify-shaped messages of ADR-0009.

Facts read from the consumers (kollekt@524f276, esa-layouts-v2@1c8ea49, ESATiltifyBridge@main):

- The bridge returns **bare** objects and arrays. It unwraps Tiltify's `{ data, meta }`.
- kollekt calls `Guid.Parse(team_id)`, requires non-null incentive ids, and parses amounts with `decimal.Parse(value, InvariantCulture)`.
- kollekt keys `Reward`, `Poll` and `Milestone` by `Id` **globally**. But its sync looks for existing rows only inside the campaign it is syncing, and it knows only campaigns that a donation (or an admin) introduced. Those are our Channels, never the Event.
- layouts concatenates the Event list ("team campaign") with this stream's Channel list.
- kollekt's `HttpClient.BaseAddress` resolves the relative path `campaigns/{id}`, so a base URL without a trailing slash loses its last segment.

## Decision

1. **Routes**, mounted at `/api/tiltify` (`server/routes/tiltify.ts`, `server/services/tiltifyApi.ts`):
   - `campaigns/{id}`
   - `campaign/{id}/rewards`, `targets`, `polls`, `polls/{poll_id}`
   - `campaign/{id}/milestones`, `matches`

   Consumers set their bridge URL to `<APP_BASE_URL>/api/tiltify/`, **with** the trailing slash. nginx already proxies `/api/`. The bridge's slug routes are not served, because no consumer calls them.

2. **Shapes.** Every response is a bare Tiltify-v5 object or array, with the fields the consumers read plus cheap neighbouring fields (full list in the #117 design comment and `openapi.yaml`). Amounts use the same `money()` as the messages. An unknown id returns 404.
   - `campaigns/{id}` resolves a Channel (`team_id` = its Event id) or an Event (`team_id: null`). Inactive Channels and Events still resolve, with `status: "retired"`, because kollekt keeps old campaigns.
   - Rewards: `amount` is the cost, and `quantity_remaining` is null when stock is unlimited.
   - Targets are FundGoals.
   - Polls: `active` means active and not past `ends_at`, and only `ACTIVE` (approved) options are listed. This is the same rule as the donation message.
   - Deactivated incentives are listed with `active: false`, the same as Tiltify.
   - `limit`, `after` and `before` are accepted and ignored, because every list is one page.
3. **Shared incentives** (`channel_id = null`) are listed under **every Channel** of the Event. The Event lists no rewards, targets or polls of its own.
   - Listing them only under the Event would show a shared reward as "Unknown Reward" in kollekt, which never syncs the Event.
   - Listing them under both would show them twice in layouts.
   - This choice needs a kollekt change (kollekt#36): look up existing rows by id across all campaigns. Without it, the second Channel's sync fails on a duplicate key.
4. **Milestones and matches** are always `[]` for a known id. We have neither. Deriving milestones from FundGoals would show each goal twice.
5. **Totals.** `total_amount_raised` comes from the same functions as the `fact.updated` message (`channelTotalCents` / `eventTotalCents`: COMPLETED + REFUNDED, §E7; an Event is the sum of its assigned donations). layouts re-reads this route when a pushed total goes down, and must get the same number.
6. **Auth.** The routes are public and read-only, like `/donate`, and the bridge had no auth either. They are rate-limited per IP by `RATE_LIMIT_TILTIFY` (default 300/min; kollekt makes about 36 requests/min per campaign). No donor data is exposed.

## Consequences

- kollekt and layouts switch by configuration only: `TiltifyBridge.Url` and `tiltify.api.url`, plus the uuids and slugs of our Event and Channels (runbook § Consumer setup).
- kollekt must ship the lookup change before an Event with two or more Channels takes donations on both.
- The API is a second place that defines what "public incentive data" means. Its shapes are fixed by consumers we do not control. Contract tests (`server/test/routes/tiltify.test.ts`) assert every field each consumer reads.

## Alternatives considered

- **List shared incentives under the Event only.** No kollekt change is needed, but kollekt loses the names of shared rewards and polls. Rejected.
- **List them under the primary Channel only.** A donation on another Channel still fails to find them, and the result depends on which Channel is primary. Rejected.
- **Require a key.** Neither consumer can send one without a code change, and the data is already public. Rejected.
