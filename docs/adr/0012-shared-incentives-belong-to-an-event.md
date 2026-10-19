# ADR-0012: Shared Incentives Belong to an Event

**Date:** 2026-10-17

**Status:** Accepted

**Related:** [ADR-0010](0010-tiltify-compatible-rest-api.md) (§3 amended), [ADR-0011](0011-pooled-allocation-accounting.md) (Pool credit scope), [ADR-0008](0008-event-channel-identity.md) (identity), esamarathon/kollekt#44 (review: "null is never really an option"), esamarathon/kollekt#36, esamarathon/esa-dono-ui#189

## Context

A **shared incentive** is a reward, poll, goal or auction with `channel_id = null`. It has no other owner: the schema has no `event_id` on incentives. This causes three problems.

1. **Downstream systems get no identifier.** Native `incentive.*` webhook messages send `channel_id: null` and nothing else. The ESA lookup routes return `campaign_id: null`. A consumer cannot tell which Event or stream an incentive belongs to. Kollekt requires every item to belong to a Campaign; its maintainer rejected `null` in the PR #44 review.
2. **"Shared" is wider than intended.** ADR-0010 says shared incentives are listed under every Channel **of the Event**. The code applies no Event filter. A shared incentive from any Event, including an ended one, is accepted by:
   - Channel lists and lookups (`server/services/tiltifyApi.ts`);
   - pledge creation and fulfillment (`server/services/pledge.ts`, `server/services/donation.ts`);
   - Pool credit spending (`server/services/poolCredit.ts`);
   - Unused pool money assignment (`server/services/unusedPool.ts`);
   - the Default goal list (`server/services/defaultGoal.ts`, `server/services/channels.ts`).
3. **Pool credit and Event end assume Event scope.** Pool credit is spendable "in that Event, or shared", and expires or converts at Event end. A global shared incentive has no Event end.

**Tiltify precedent.** A Tiltify team campaign has its own team-level rewards, polls and targets. They are shared to the team's member campaigns, and Tiltify serves them from the team campaign's endpoints (`getTeamCampaignRewards`, `getTeamCampaignPolls`, `getTeamCampaignTargets`). Their owner is the team campaign. ADR-0010 already maps the team campaign to our Event and a campaign to our Channel, and ESATiltifyBridge answered `campaign/{id}/…` from the team endpoint first.

Consumers, read at kollekt `b955b6d` (same lines on `master`) and esa-layouts-v2 `009487a`:

- **The overlay** follows the Tiltify pattern for polls and milestones: it reads the team campaign **and** this stream's campaign and concatenates the lists without removing duplicates (`src/extension/util/tiltify.ts:95-106,141-152`, unchanged since upstream `1c8ea49`). Target reading is not upstream. Our unmerged commit `009487a` added it and reads only this stream's campaign, because Channels include shared targets today.
- **Kollekt** stores a team campaign as an ordinary `Campaign`. It creates one from a donation only when the donation has no `campaign_id` (`SyncService.cs:21`). Our Tiltify donations always carry `campaign_id`, so Kollekt never creates or syncs the Event's Campaign. Its sync marks an incentive inactive when the incentive is missing from the list of the Campaign that owns it. Incentive rows are keyed by global id. A cold poll or target found during ingestion is created under the **donation's** Campaign, even when another Campaign owns it (`IngestionService.cs:163,198`). `Campaign.TeamId` is used for Tiltify management links.

## Decision

1. **A shared incentive is a team-level incentive.** Every reward, poll, goal and auction gets a required `event_id`.
   - A **Channel incentive** also has a `channel_id`. Its Channel must belong to the same Event.
   - A **shared incentive** has `channel_id = null`. It is available on every Channel of **its** Event, and only there.
   - An incentive never moves to another Event. To use it in a later Event, copy it.
2. **Event scope applies everywhere.** Every check in Context §2 accepts a shared incentive only when its `event_id` equals the Event of the donation, pledge or Channel. A shared incentive of another Event is not available.
   - Direct Wallet spends (`POST /api/rewards/:id/claim`, `/api/polls/:id/vote`, `/api/polls/:id/custom-entry`, `/api/goals/:id/contribute`) had no scope check. Like a pledge, each now requires an active `channel_id` and accepts only an incentive available on that Channel (`server/services/spend.ts`).
3. **The owner is never null on the wire.** These changes are additive; existing fields keep their meaning.
   - Native `incentive.*` messages add `event_id` (never null). `channel_id` stays null for a shared incentive.
   - The ESA lookup routes return the owner as `campaign_id`: the Channel id for a Channel incentive, the **Event id** (team campaign) for a shared incentive. `campaigns/{id}` already resolves an Event id as a team campaign (ADR-0010 §2).
   - Tiltify donation messages do not change. They already send `campaign_id` and `team_event_id`.
4. **The Event lists its shared incentives, like a Tiltify team campaign** (amends ADR-0010 §3). `campaign/{eventId}/rewards`, `targets` and `polls` list the Event's shared incentives, and `campaign/{eventId}/polls/{poll_id}` serves a shared poll. Channel lists keep listing them too, so consumers that read only Channel lists keep working. Removing them from Channel lists is a separate, later decision (see Consequences).
5. **Rollout order.** Each step ships separately.
   1. Producer: `event_id`, Event scope, owner identifiers (Decisions 1–3). Lists unchanged.
   2. Overlay: remove duplicate polls by id, as it already does for targets, and read targets from the team campaign as well as this stream's campaign.
   3. Producer: Event lists include the Event's shared incentives (Decision 4). Current Kollekt never syncs an Event Campaign, so it is unaffected; the step 2 overlay removes the duplicates.
   4. Kollekt: file each incentive under its owner from the lookup, the Event's Campaign for a shared incentive (kollekt#44). Its sync job also syncs that Event Campaign and marks incentives missing from the Event's list inactive, so step 3 must be deployed first.

## Migration

- A Channel incentive gets the `event_id` of its Channel.
- A shared incentive gets the only Event when exactly one Event exists. Otherwise it gets the one Event in which it has allocations: reward claims, poll votes or goal contributions, through their donations or Pool credit batches. Auctions have no Event-linked allocations, so a shared auction needs a single Event.
- If neither rule gives exactly one Event, the migration fails and changes nothing. `docs/deployment.md` lists the query that finds these incentives. An operator gives each one a Channel, or splits it into one copy per Event, marks the failed attempt rolled back and runs the migration again.
- SQLite triggers keep the invariant for every writer: a Channel incentive's `event_id` equals its Channel's Event, and a Channel that owns incentives cannot move to another Event.

## Consequences

- Downstream systems always get an owner identifier, and Kollekt can file shared incentives under the Event's Campaign, as its maintainer proposed.
- A shared incentive of one Event no longer appears on, or accepts money from, another Event. This fixes a real scope bug, not only a wire problem.
- Admin and moderator forms need an Event for shared incentives. "Shared" now means "shared within this Event".
- A consumer must use the lookup owner, not the list it read a shared incentive from: Channel lists keep listing shared incentives.
- Kollekt keeps the first owner it stored for an incentive that a Channel list introduced, and its missing-from-list check covers only rows that the synced Campaign owns. Removing shared incentives from Channel lists would therefore flip those rows inactive; it needs a Kollekt owner repair first.
- Kollekt needs `TiltifyBridge__Source=EsaDono` to use the owner lookups.
- The schema change is hard to reverse once incentives exist in two or more Events.

## Alternatives considered

- **Keep shared incentives global and add a synthetic owner id.** No migration, but cross-Event scope stays open, and the owner id has no meaning in Tiltify or Kollekt. Rejected.
- **List shared incentives only under the Event (pure Tiltify team style).** Current Kollekt never syncs the Event's Campaign, and Kollekt rows that Channel lists introduced would flip inactive. Deferred until consumers no longer depend on Channel lists.
- **List them only under each Channel and add only owner ids.** Kollekt would file shared incentives under the Event's Campaign but never find them in its list, so its sync would mark them inactive. Rejected.
- **Ship Kollekt before the Event lists.** Kollekt would sync the Event Campaign's empty lists and mark shared incentives inactive, and Channel syncs would reactivate them, in database order. Rejected.
- **Give shared incentives to the primary Channel.** The owner then changes when the primary Channel changes, and other Channels still need a special case. Rejected (as in ADR-0010).
