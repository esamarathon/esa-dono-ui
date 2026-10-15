# API consumers outside this repo

Callers of this backend that live in sibling folders of this repo, under
`/var/lib/ai-workspace/projects/esa/`. That parent folder is not a git repository. Check this
list before you rename, remove or reshape an endpoint or a response field. Then confirm it,
because the list can be stale:

```bash
cd /var/lib/ai-workspace/projects/esa && rg -uu -n \
  --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/dist/**' --glob '!**/.venv/**' \
  --glob '!esa-dono-ui*/**' '<endpoint path or field name>'
```

Paths below are relative to `/api`.

## Message and read-API consumers

- **kollekt** and **esa-layouts-v2**: the Tiltify-compatible messages (a `TILTIFY` Destination) and
  the Tiltify-compatible REST API under `/tiltify`. See `docs/outbound-events.md` § Consumer setup
  and ADR-0010.
- **esa-observability**: scrapes `GET /metrics` (`config/victoriametrics/promscrape.yml`, job
  `dono-backend`). Its README queries `dono_donated_cents_total`. See `docs/webhooks-and-metrics.md`.

## Optional ESA incentive lookup capability (#189)

The Tiltify-compatible API adds only these optional ESA-specific reads (relative to
`/api/tiltify/`, retaining the trailing slash on the consumer's base URL):

- `GET campaign/:id/lookup/rewards/:reward_id`
- `GET campaign/:id/lookup/targets/:target_id`
- `GET campaign/:id/lookup/polls/:poll_id`

A successful response is `{campaign_id: string | null, incentive: <existing bare DTO>}`.
`campaign_id` is the incentive's **true owning Channel UUID**, or `null` for shared
incentives, not the requested context. `:id` must resolve to a known Channel or Event,
including inactive historical identities. An owned incentive must belong to a Channel
in that same Event; shared incentives are allowed. An unknown context/resource or an
owner in another Event returns 404. Lookup reads current amounts, active state, stock
and approved poll options through the same builders as the existing lists/detail.
No donor email, staff information, claim answers or other private data is returned.

This is an optional ESA capability for Kollekt to resolve cold or stale cross-Channel
references after pooled allocations. A legacy source or 404 keeps the consumer's old
behavior; no new configuration, auth or feature flag is required. Keep these envelopes
separate from ordinary Tiltify models. Consumers must handle globally unique shared
incentive ids without duplicate inserts and retain the verified owner when resolving
cross-Channel metadata. Donation source Channel routing, money and ids never change.

Existing Channel lists remain own plus shared; Event incentive lists remain `[]`.
Ordinary `polls/:poll_id` remains scoped to that Channel's own/shared polls (404 for an
Event or another Channel's poll). Nothing changes overlay list scope. The focused
[Kollekt PR44](https://github.com/esamarathon/kollekt/pull/44) transport/ingestion fix is a
coordinated dependency for cold/stale cross-Channel hydration, not an optional operator
briefing. It retains verified incentive ownership, consumes supplied per-target allocation
values and preserves processed claim state on donation replacement. The original PRD's
"no consumer change" assumption does not cover this case. Producer/unit/wire tests alone
do not establish combined-consumer release readiness: cold and warm runtime checks must
use pinned source/image revisions without prewarming, list widening or donation rerouting.

## Test and staging tooling (parent folder)

| Caller                      | How it runs                                                    | Endpoints                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging/reconcile.py`      | **systemd timer on staging** (`esa-consumers-reconcile.timer`) | `GET /channels`, `GET /admin/events`, `GET`/`POST`/`PUT /admin/destinations`, `/tiltify/…`                                                                                                                                                                                                           |
| `scripts/e2e-incentives.ts` | `scripts/test-incentives.sh`                                   | `POST /pledge`, `GET /pledge/:token`, public poll/goal/reward spend routes, `POST /admin/{polls,goals,rewards,simulate-donation}`, `GET /admin/donations`, `GET /admin/claims`, `GET /moderator/polls/:id/custom-entries`, `PATCH /moderator/polls/custom-entries/:id`, `GET /tiltify/campaigns/:id` |
| `scripts/e2e-overlay.ts`    | `scripts/e2e-common.sh`                                        | `GET`/`POST`/`PUT /admin/events`, `GET`/`POST`/`PUT /admin/channels`, `/admin/destinations` (incl. `/:id/deliveries`), `POST /admin/simulate-donation`, `GET /tiltify/campaigns/:id`                                                                                                                 |
| `scripts/test-e2e.sh`       | manual / E2E                                                   | `GET /health`, `GET /admin/stats` (status code only)                                                                                                                                                                                                                                                 |
| `scripts/start-e2e.sh`      | E2E startup                                                    | `GET /health`                                                                                                                                                                                                                                                                                        |
| `staging/smoke-test.py`     | manual                                                         | `/admin/destinations`, `POST /admin/simulate-donation`, `GET /channels`, `GET /tiltify/campaigns/:id`                                                                                                                                                                                                |
| `staging/incentive-test.py` | manual                                                         | `POST /admin/simulate-donation`. It also imports `services/pledge.ts` `createPledge` and the shared planner directly; after applying the tracked #194 patch it uses explicit D/draft/plan and `pledge.new_money_cents`.                                                                              |

## Amount-first pledge contract (#185)

`POST /pledge` now requires `pledge_amount_cents`, a stable `draft_id`, the client-shown
`plan` from `@dono/shared` `planPledge`, `channel_id`, and `items` (possibly empty).
`top_up_cents`, or a missing pledge amount, returns 400:
"The donate page was updated. Reload to continue."

A valid donor session is resolved before planning; email alone cannot fund a pledge.
A new-attempt mismatch returns 409 with `{error, plan, items}` and no pledge or Wallet
hold. Confirm the corrected review before resubmitting. Existing-draft retries return
the original server plan with its held funding before comparison. Each category has
an independent Pool; `Donation.amount_cents` and money totals count **new money only**,
not Wallet funding, incentive amounts or shipping.

New POST/GET responses have `format: POOLED`, `pledge_amount_cents`, `plan`,
`wallet_applied_cents`, `new_money_cents` and `requires_shipping`. They never expose
`total_cents`, `top_up_cents` or `wallet_discount_cents`. GET still supports a read-only
`format: LEGACY` variant with historical totals/items; it is not a new pledge contract.
No donor email or session token is exposed by this read endpoint.

The repo simulator reads `/donor` and live `/rewards`, sends the shared plan and a stable
run/donor/sequence draft id, and verifies `/pledge/:token` fulfillment. It does not
complete Stripe or release held funding. Tiltify retains its existing shape; pooled
donor/auto rows are combined per option/goal and allocations remain distinct from money.

**Coordinated rollout (#194):** apply the tracked `scripts/parent-pledge-callers.patch`
from the ESA parent root as described in `docs/deployment.md`. The parent is not a Git
repository; the patch is the version-controlled delivery artifact. Until applied, those
external files still use the obsolete contract and must not run against this release.
The public caller confirms a real corrected-409 plan and independently tests D1500:
reward1500, polls500+1000, goals643+857 (money1500, not category sum4500). The direct
staging caller uses the shared planner. Both settle through admin simulated intake,
preserving optional pledge token and external id; neither claims Stripe Checkout or
exact-Session coverage. Physical direct-Wallet claims must reject without side effects.
The matrix requires a dedicated fresh sandbox; the staging probe has no live defaults.

Historical correction replays retain donation ids, statuses, refund links and allocations.
Verified shipping is extracted once from all four known legacy statuses, including PENDING
and CHARGEBACK. It lowers receipt amount and cumulative donor `total_donated`, but changes
counted-money totals only for COMPLETED/REFUNDED. Operator reports distinguish `received_cents`
(all-status current cash receipts, excluding exact `wallet-<uuid>` identifiers) from
`counted_cents`. A positive fee requires the donor total to match that receipt history;
ambiguous totals require manual review, not normalization to counted money. The unshipped
wallet backfill, report selection and publication proof all require the literal `wallet-`
prefix plus an exact 8-4-4-4-12 hexadecimal UUID (either hex case); non-UUID wallet-prefix
cash is not zeroed or treated as Wallet-only. These corrections do not repair old reversals.
See `docs/deployment.md` for binding acknowledgement and non-dispatching publication.

## Checkout reconciliation contract (#186)

All paths are relative to `/api`, with empty POST bodies:

| Endpoint                               | Contract                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /pledge/:token`                   | Immutable POOLED/LEGACY review and derived payment state; no email/auth token.                                                                                        |
| `POST /pledge/:token/reconcile`        | Public exact-token Stripe reconciliation, never donor authentication.                                                                                                 |
| `POST /pledge/:token/cancel`           | Expire first, retrieve if unclear; release once only after confirmed non-payment. Wallet-bound pledges require their owning donor session. LEGACY is read-only (409). |
| `POST /pledge/:token/continue`         | Reconcile then return the same payable Session, or retry the frozen create/key within 24h. No replanning. Same owner/LEGACY restrictions as cancel.                   |
| `POST /admin/pledges/:id/check-stripe` | Admin key/ADMIN donor session only; the same reconciliation. No manual release.                                                                                       |

Common public fields: `payment_state`, `can_edit`, `can_continue`, `read_only`,
`admin_review_required`, `donate_url` (nullable), and `has_checkout`. POST `/pledge`
also returns nullable `checkout_error`; a failed create retains its confirmed plan/hold.
Action conflicts return 409 with `{error, pledge}` (the safe public projection).

States:

- `READY`: confirmed, with no known payment attempt (also possible with Stripe unconfigured).
- `OPEN`: continue only the same Session. The review stays read-only.
- `PROCESSING`: complete/unpaid; payment can still settle. Keep the hold and block edits/new checkout. An async-failure notification with current processing/retryable PaymentIntent evidence also retains funding; its receipt allows later reconciliation.
- `UNKNOWN`: create/expire/retrieve is unresolved. Keep the hold and block edits/new checkout.
- `NON_PAYMENT`: authoritative non-payment; only a POOLED pledge has `can_edit=true`/`read_only=false`.
- `FULFILLED`: original immutable plan fulfilled once; never undone by a cancel/expired response.
- `LEGACY_PAID`: derived from an old-shape pledge's linked cash-only receipt, with raw `status=EXPIRED`; original historical `FULFILLED` pledges remain fulfilled. New money is Wallet credit without D/allocations. Historical review stays read-only; pledge amount is unavailable. A legacy lost create with no stored Session id atomically binds its first verified paid non-recovered Session for this cash-only receipt, never for original incentive fulfillment.
- `PAYMENT_REVIEW`: contradictory paid-after-release money recorded as NULL-D Wallet credit because all original W could not be reacquired. `admin_review_required=true`. Do not report original incentives fulfilled or delete a draft as a fulfilled pledge.

A late pooled payment fulfills normally while funding stays held, or after atomically
reacquiring all released W. Under the [approved amendment](https://github.com/esamarathon/esa-dono-ui/issues/186#issuecomment-6164165797),
D=1000/W=950/cash=50 with W spent elsewhere records only cash=50 as legacy Wallet credit,
with the original pledge linked, routing/comment/name retained and no allocations/debt.
Shipping stays outside all totals. Both special late outcomes are distinct from `FULFILLED`.

Stripe success returns to `/pledge/:token`; cancel returns to `/pledge/:token?cancelled=1`.
A browser cancel and an elapsed local deadline are not non-payment. Session recovery is
disabled. Lost-create retries reuse exact parameters/key only within 24 hours; later
reconciliation discovers the original Session without issuing another create. Unknown
or ambiguous discovery remains blocked. No operation establishes a donor session.

Stripe adapters/synthetic tests must provide `status='complete'` and `payment_status='paid'`
to record payment; `completed` alone is insufficient. Pooled Stripe intake also requires
the exact persisted Checkout Session id. Supplying an unknown pledge token never falls
back to email; no-token historical matching remains legacy-only. Existing auction
completed/expired handling and Tiltify wire shapes are unchanged. The tracked #194 caller
patch avoids fake Stripe Session injection; it does not weaken this boundary.

Legacy async-failure handoff: `reconcileCheckoutNotification` returns
`{legacy_async_failure: {donation_id, checkout_session_id, pledge_token}}` internally for an existing
NULL-D donation and persists the bound pledge's `payment_status='failed'`. The webhook
consumes it through the common legacy chargeback transaction and publisher before responding
`{received:true}`. Duplicates and terminal historical records do not adjust credit twice.

## Reversals and current-state messages (#188)

`GET /admin/donations/:id/reversal-preview?status=REFUNDED|CHARGEBACK` returns the same
server-computed Wallet/money/row/retained-claim effect used on confirmation. Status PATCH
retains its path and response, with admin-only email added in the router. `REQUESTED`
Payment refunds return 409; terminal and zero-money chargebacks are blocked. Claims permit
only live PENDING/FULFILLED transitions; charged-back/REQUESTED claims return 409.
`POST /admin/claims/:id/acknowledge-chargeback` accepts optional `{note}` and clears a
shipped flag, recording actor/time without changing stock or credit.

Pooled row reversals create category Pool credit (donor/auto) or computed Unused pool money
(moderator), never Wallet credit. Legacy rows retain one-to-one Wallet refunds at recorded
prices. Goal completion is recomputed against its target after ordinary reversals; chargebacks
keep completed goals complete. Shared services and moderator responses never include donor email.

Pool credit is combined per category across the donor's source donations in one Event,
with own-Event/all-Channel and shared targets. Draws use oldest donation first. Canonical
`PoolCreditRedemption` rows can fund one whole reward claim from several donations; a null
claim donation id is not proof of legacy Wallet spending. Effective component funding is
original consumption minus audited refund reduction. Native allocations show source-local
shares, while Tiltify carries the whole claim once under its stable oldest-source carrier.
Reversal restores original grants. This does not widen ordinary incentive list scope.

Native `donation.created` adds status, pledge amount, Wallet funding and live `allocations`
with source. New `donation.updated` carries the same full safe data and requires explicit
Destination opt-in. Tiltify keeps money/scalars/lists/goal-amount contracts with no source;
changed allocations replace the donation under the same id. See `docs/outbound-events.md`.
