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

`scripts/e2e-incentives.ts` declares the response fields it reads in the interfaces at the top of
the file. It also asserts that a donation's `amount_cents` equals its pledge's `total_cents`, which holds
only for the pre-pool pledge flow.
