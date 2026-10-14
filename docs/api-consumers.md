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

## Test and staging tooling (parent folder)

| Caller                      | How it runs                                                    | Endpoints                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging/reconcile.py`      | **systemd timer on staging** (`esa-consumers-reconcile.timer`) | `GET /channels`, `GET /admin/events`, `GET`/`POST`/`PUT /admin/destinations`, `/tiltify/…`                                                                                                                                                                                                                                    |
| `scripts/e2e-incentives.ts` | `scripts/test-incentives.sh`                                   | `POST /pledge`, `GET /pledge/:token`, `POST /webhooks/stripe`, public poll/goal/reward spend routes, `POST /admin/{polls,goals,rewards,simulate-donation}`, `GET /admin/donations`, `GET /admin/claims`, `GET /moderator/polls/:id/custom-entries`, `PATCH /moderator/polls/custom-entries/:id`, `GET /tiltify/campaigns/:id` |
| `scripts/e2e-overlay.ts`    | `scripts/e2e-common.sh`                                        | `GET`/`POST`/`PUT /admin/events`, `GET`/`POST`/`PUT /admin/channels`, `/admin/destinations` (incl. `/:id/deliveries`), `POST /admin/simulate-donation`, `GET /tiltify/campaigns/:id`                                                                                                                                          |
| `scripts/test-e2e.sh`       | manual / E2E                                                   | `GET /health`, `GET /admin/stats` (status code only)                                                                                                                                                                                                                                                                          |
| `scripts/start-e2e.sh`      | E2E startup                                                    | `GET /health`                                                                                                                                                                                                                                                                                                                 |
| `staging/smoke-test.py`     | manual                                                         | `/admin/destinations`, `POST /admin/simulate-donation`, `GET /channels`, `GET /tiltify/campaigns/:id`                                                                                                                                                                                                                         |
| `staging/incentive-test.py` | manual                                                         | `POST /admin/simulate-donation`. It also imports `services/pledge.ts` `createPledge` directly and reads `pledge.total_cents`.                                                                                                                                                                                                 |

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

**Coordinated follow-up (#194), not changed by #185:** `scripts/e2e-incentives.ts` reads
and asserts `total_cents`; `staging/incentive-test.py` calls `createPledge` directly and
posts that old total as money. Both must adopt the shared planner/new-money contract
before the single pooled release. Do not run those old callers against this intermediate
branch. Checkout reconciliation (#186) and the donate client (#187) are also required.
