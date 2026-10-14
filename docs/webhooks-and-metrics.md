# Stripe Webhook Registration

1. **Expose your server**: Use a reverse proxy or tunnel tool like [ngrok](https://ngrok.com):

   ```bash
   ngrok http 3001
   ```

2. **Register in Stripe**: In the Stripe Dashboard, add a webhook endpoint:

   - **URL**: `https://<your-ngrok-url>/api/webhooks/stripe`
   - **Events**: Select `checkout.session.completed`

3. **Set the secret**: Copy the signing secret (`whsec_…`) and set it in `.env`:

   ```
   STRIPE_WEBHOOK_SECRET=whsec_<your-signing-secret>
   ```

4. **Checkout sessions**: Set `STRIPE_SECRET_KEY` so `POST /api/pledge` can create hosted Checkout sessions for pledges; leave it unset to fall back to a no-hosted-checkout mode (`donate_url: null`).

During local development you can leave `STRIPE_WEBHOOK_SECRET` unset to skip HMAC signature verification.

## Metrics (Prometheus)

The backend exposes `GET /api/metrics` in Prometheus text format. It's reachable through the same public path as the rest of the API (no separate network restriction) and is protected entirely by its own bearer token.

**Metrics exposed:**

- **Runtime/process metrics** — CPU, memory, event loop lag, GC pauses (via `prom-client`'s default collectors). These are per-instance and reset on restart; that's expected and handled correctly by Prometheus's `rate()`/`increase()`.
- **HTTP metrics** — `http_requests_total` and `http_request_duration_seconds`, labeled by method/route/status.
- **Business metrics** (`dono_*`) — database-derived gauges, refreshed on a background interval (`METRICS_REFRESH_MS`, default 45s). Scrapes read the cache and never query the database. A failed refresh keeps the previous snapshot, increments `dono_metrics_refresh_errors_total`, and leaves `dono_metrics_last_refresh_timestamp_seconds` unchanged. Inspect that timestamp before treating cached values as current. Auction, webhook queue and transport metrics keep their existing meanings; queue gauges are listed in `docs/outbound-events.md`.

### Money, incentives and credit

**Only `dono_donated_cents_*` measures charity money.** It sums current
`Donation.amount_cents` for `COMPLETED` and `REFUNDED` donations, including hidden
ones. A Wallet refund keeps money at the charity. An accepted Payment refund
lowers the amount in place; giving a failed Payment refund as Wallet credit
restores it. `CHARGEBACK` and `PENDING` donations do not count. Shipping is always
excluded. A Wallet-only pledge adds no money.

Incentive allocation, Unused pool money and Pool credit are **not additional charity
money**. One dollar can back rewards, polls and goals independently. Do not sum
across these categories, add them to money, or mix them with Wallet credit.
Pool credit is an effective category obligation, not a second donation.

Event/Channel labels are **slugs**, not ids. Global gauges have no scope labels;
use the corresponding breakdown instead of adding both together.

| Gauge                                                        | Labels                             | Meaning                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dono_donated_cents_total` / `dono_donated_cents_by_channel` | none / `event, channel`            | Counted money above; breakdown follows the donation.                                                                                                                                                                                                        |
| `dono_donations_total` / `dono_donations_by_channel`         | none / `event, channel`            | All donation rows, whatever their status. Unassigned labels are `""/""`.                                                                                                                                                                                    |
| `dono_reward_claims_total` / `dono_reward_claims_by_channel` | none / `event, channel`            | Live entitlements only: `PENDING`, `FULFILLED`, `CANCELLING`, with no reversal. One claim remains one entitlement even with several financial components. Breakdown follows the reward.                                                                     |
| `dono_poll_votes_total` / `dono_poll_votes_by_channel`       | none / `event, channel`            | Live vote row counts (not cents); breakdown follows the poll.                                                                                                                                                                                               |
| `dono_incentive_allocated_cents_by_channel`                  | `event, channel, category, source` | Live financial allocations, `category=reward\|poll\|goal`, `source=donor\|auto\|moderator`. Rewards are always donor-source. Labels follow the **incentive**, even for cross-Channel credit spending; shared incentives use `event="", channel=""`.         |
| `dono_pool_unused_cents_by_channel`                          | `event, channel, category`         | Computed Unused pool cents, `category=poll\|goal`. Labels follow the **donation**.                                                                                                                                                                          |
| `dono_pool_credit_cents_by_channel`                          | `event, channel, category`         | Effective Pool credit, `category=reward\|poll\|goal`. Labels follow the **donation**.                                                                                                                                                                       |
| `dono_wallet_credit_cents`                                   | `state`                            | Separate `available` and `held` Wallet credit. Held credit is not spendable.                                                                                                                                                                                |
| `dono_pledges_open`                                          | none                               | OPEN Pending pledge count; age does not confirm non-payment or release a hold.                                                                                                                                                                              |
| `dono_pledges_overdue`                                       | none                               | OPEN pledges strictly past `expires_at` whose Checkout Session is not `complete`, including unknown/null Session state. A complete but unpaid Session is processing, not overdue.                                                                           |
| `dono_payment_refunds`                                       | `status`                           | Record counts for `requested`, `pending`, `requires_action`, `succeeded`, `failed`, `resolved`. Rejected-at-creation attempts are resolved. Shipping does not create another record/count; unresolved failed shipping may remain on a resolved item record. |
| `dono_payment_refunds_oldest_requested_age_seconds`          | none                               | Age of the oldest REQUESTED record, or zero if none.                                                                                                                                                                                                        |
| `dono_balance_adjustments_total`                             | `type`                             | Adjustment row counts, including `WALLET_REFUND` and `FAILED_PAYMENT_REFUND`. `REFUND` means legacy item reversal; existing `FREEZE_ZERO`, `MANUAL`, `CHARGEBACK` remain.                                                                                   |

Allocation cents use recorded amounts, never current catalog prices. A
`CANCELLING` physical claim stays live until Stripe accepts the refund. Credit-backed
rewards sum effective financial components (`amount_cents - reduced_cents`), not
one whole price for each source. Poll/goal stored amounts are already current and
must not have reductions subtracted again. Live pending-option votes, ended polls
and completed goals still reserve their financial allocations.

Event end is derived, not a persisted transfer: poll/goal Pool credit becomes
Unused pool money and reward Pool credit expires. Raw grants remain for Undo end.
Unused is calculated after effective reservation and live assignments, using the
same max-rule accounting as donor and staff actions; failed-Payment-refund Wallet
gaps are not Unused. Legacy (null pledge amount) donations have no Pools.

`dono_donations_unassigned` counts donations waiting for routing.
`dono_events_active` counts active Events; `dono_channels_active` counts active
Channels (the former counted Channels before #115).

### Staff stats agreement

`GET /api/admin/stats` and `GET /api/moderator/stats` use the same tx-aware bulk
aggregation as business gauges. APIs read a current snapshot; gauges may lag by
one refresh interval. Admin overall `pledged_cents` sums current D for pooled
COMPLETED/REFUNDED donations; it is separate from `total_raised_cents`.
`wallet_credit_cents: {available, held}` replaces `unallocated_credits_cents`;
`claims` is live-only; `pledges: {open, overdue}` and
`payment_refunds: {requested, failed}` are counts. Channel entries separate
`raised_cents`, `pledged_cents`, incentive-scoped `allocated_cents: {reward, poll, goal}`,
and donation-scoped `unused_pool_cents: {poll, goal}` and
`pool_credit_cents: {reward, poll, goal}`. `shared.allocated_cents` holds shared incentives.
Moderator `unused_pool.with_comment` and `.all` each contain distinct `donations`
and `cents: {poll, goal}`, excluding ended Events and zero-unused donations.
Comments must be nonblank. No donor email is selected or returned.

### Replicas and operator queries

**Consumers.** The sibling repo `esa-observability` scrapes this endpoint (job
`dono-backend` in `config/victoriametrics/promscrape.yml`); its README consumes
`dono_donated_cents_total`. That money metric's meaning is unchanged. Check current
consumers before renaming, relabelling or removing a series.

Database-backed gauges repeat the same state on every replica. **Deduplicate with
`max without (instance)` before any aggregation.** Preserve category/source/scope
labels during deduplication. Do not apply this rule to per-instance HTTP, runtime
or transport counters. Examples:

```promql
# Overall charity money (never add incentive or shipping cents).
max without (instance) (dono_donated_cents_total)

# Per-Event poll allocations only, combining Channels and sources after deduplication.
sum by (event) (
  max without (instance) (dono_incentive_allocated_cents_by_channel{category="poll"})
)

# Unused goal cents by source Event; do not combine with the poll category.
sum by (event) (
  max without (instance) (dono_pool_unused_cents_by_channel{category="goal"})
)
```

Optional external alert recommendations (not installed by this application): an
oldest requested Payment refund age over five minutes, any overdue pledge, or a
stale metrics refresh timestamp. A requested refund needs reconciliation, not a
second refund. Overdue alone never authorizes hold release. Keep failed-shipping
recovery visible through the admin Payment refund list even after item resolution.

### Obtaining and configuring the token

1. Generate a random secret, e.g.:

   ```bash
   openssl rand -hex 32
   ```

2. Set it as `METRICS_API_KEY` in your `.env` (or the container's environment):

   ```
   METRICS_API_KEY=<your-generated-secret>
   ```

   If `METRICS_API_KEY` is left unset, `/api/metrics` returns `404` rather than serving unauthenticated data.

3. Point Prometheus (or curl) at the endpoint using the `key_metrics_` prefix, following the same `Authorization: Bearer` scheme used by the admin/moderator keys:

   ```bash
   curl -H "Authorization: Bearer key_metrics_<your-generated-secret>" http://localhost:3001/api/metrics
   ```

   Example `scrape_configs` entry for a Prometheus server:

   ```yaml
   scrape_configs:
     - job_name: dono-backend
       metrics_path: /api/metrics
       scheme: https
       authorization:
         credentials: key_metrics_<your-generated-secret>
       static_configs:
         - targets: ['donations.example.com']
   ```

Since the endpoint is public, it's also rate-limited per IP (`RATE_LIMIT_METRICS`, default 30/min) as a backstop against unauthenticated scraping/scanning traffic.
