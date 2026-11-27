# 2. Migrate Payment Processing from Tiltify to Stripe

- Status: Proposed
- Date: 2026-08-10
- Author: TBD
- Deciders: TBD

## Summary

Replace Tiltify with Stripe for donation payment processing, using Stripe hosted
Checkout Sessions. Physical-item shipping addresses are collected and stored by Stripe
(not our database), minimizing the PII we hold. This is a hard cutover with no
dual-provider path.

## Context

The platform currently proxies donations through Tiltify: an OAuth2 client-credentials
API, webhook relay keys for deterministic pledge linkage, and HMAC-verified inbound
webhooks. The existing Tiltify flow is documented in `CLAUDE.md`.

Drivers for change: consolidate on Stripe for payment processing and own the
donor/checkout experience. No production data exists yet, so a destructive column-rename
migration is safe.

Constraints:

- Minimal PII in our DB: store only username + email (plus a Stripe customer-id pointer).
- Card data must never transit our application — mandates hosted Checkout.
- Donor comments must remain available (up to 500 chars).
- Physical items must always trigger a checkout so Stripe can collect a validated address.

## Decision

Adopt Stripe hosted **Checkout Sessions** as the payment mechanism.

- Pledge total is a fixed line item. Pledge linkage moves from Tiltify relay keys to
  Checkout Session `metadata.pledge_token` / `client_reference_id`.
- Webhooks are verified via `stripe.webhooks.constructEvent` at `/api/webhooks/stripe`
  (raw body preserved before `express.json()`), handling `checkout.session.completed`.
- Donor comments are collected in our own `/donate` UI before redirect (≤500 chars,
  blocked-word filtered), stored on the pledge, and attached to the donation at
  fulfillment — not collected on Stripe's page.
- Campaign totals are computed from our DB (`SUM(Donation.amount_cents)`), goal from
  `CAMPAIGN_GOAL_CENTS`.
  _(Superseded in part by #148: `CAMPAIGN_GOAL_CENTS` is retired and the donor
  site shows no public aggregate total or goal — the stream overlay owns the
  public display. `GET /api/campaign` survives as a minimal totals read for API
  consumers (`{total_raised_cents}`, no goal; #148 amendment), optionally
  scoped to an Event or Channel. The counting rule itself is unchanged in
  `lib/donationTotals.ts`.)_
- Physical items always run a Checkout (item discounted to $0 when wallet-funded)
  attached to a per-donor Stripe Customer that holds the validated shipping address.
  Shipping is charged at claim time, flat by item size (SMALL/MEDIUM/LARGE) with a
  per-item override for oversized items, gated by a forward-only donor `covers_shipping`
  preference disclosed before checkout. The reward always ships regardless of coverage.
  The shop reads purchased items, addresses, and shipping status from Stripe; our app
  stores no address.

The full change plan and file-level change map live in the handoff at
`/tmp/opencode/handoff-tiltify-stripe-migration.md`.

## Alternatives Considered

1. **Stripe Payment Element (embedded form)** — keeps the donor on-site.
   - Pros: unified UX; could carry >255-char comments in PaymentIntent metadata.
   - Cons: card-entry / PCI surface enters our client; significant UI + 3DS handling.
   - Rejected: violates "no sensitive data in app."

2. **Stripe Payment Links (static)** —
   - Pros: minimal code.
   - Cons: cannot attach per-pledge metadata dynamically; poor cart linkage.
   - Rejected: incompatible with the pledge/cart model.

3. **Provider-switchable abstraction (Tiltify + Stripe)** —
   - Pros: fallback/rollback to Tiltify.
   - Cons: added abstraction and dual code paths for no current need.
   - Rejected: hard cutover chosen; no prod data to protect.

4. **Stripe `shipping_address_collection` at donation time only** —
   - Cons: cannot capture addresses for wallet-funded physical claims made later in the
     event (no live session at claim time).
   - Rejected: physical claims can occur standalone mid-event; addressed instead via a
     per-claim address-collection Checkout.

## Consequences

- Benefits: single payment provider; hosted PCI scope; minimal PII footprint (addresses
  live on Stripe); deterministic pledge linkage via metadata; campaign totals no longer
  depend on an external API.
- Trade-offs: comments capped at 500 chars and collected in-app pre-redirect (not on
  Stripe's page); address access and fulfillment happen in the Stripe Dashboard / shop
  backend, not our UI; physical Rewards must sync to Stripe Products.
- Risks:
  - Fully-discounted 0-total Checkout with shipping collection may be disallowed by
    Stripe — mitigate via a spike; fallback to `mode:'setup'` or a nominal charge.
  - Webhook signature regressions — mitigate with tests using
    `stripe.webhooks.generateTestHeaderString`.

## Implementation

- Prerequisites: Stripe account + API keys (secret + webhook signing secret); Shipping
  Rates for SMALL/MEDIUM/LARGE; currency confirmed (usd).
- Steps: two-phase plan (Phase 1 core cutover, Phase 2 physical shipping) detailed in the
  handoff doc. Run the 0-total Checkout spike before committing the discount path.
- Success criteria: `npm run typecheck`, `npm test`, and `scripts/smoke-test.sh` pass with
  a Stripe-shaped signed webhook; donation → wallet credit → pledge fulfillment verified
  end-to-end.
- Reversibility: hard cutover; rollback = git revert of the migration branch. No prod
  data migration required. Tiltify code is removed, so re-enabling it means reverting.
