# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can contain
breaking changes.

## [Unreleased]

## [0.2.0] — 2026-09-29

Outbound webhook queue review and Tiltify compatibility (epic #112, PRD-0002). kollekt
and esa-layouts-v2 can now run on this platform instead of Tiltify and ESATiltifyBridge.

### Upgrade notes

- **Database migrations run on startup and cannot be reversed.**
  - Every id becomes a UUID.
  - Existing Channels join a new `default-event` Event and get the slug
    `channel-<old id>`.
  - Donations get their Event.
  - Back up `/data/dono.db` first (`docs/deployment.md` § Backup).
- **Set `TRUST_PROXY=2` behind an external proxy** (Caddy, a TLS terminator, a load
  balancer). With the default `1`, every visitor shares one rate-limit counter (#140).
  See `docs/deployment.md` § Client IP and `TRUST_PROXY`.
- **New env vars:**
  - `RATE_LIMIT_API` (600/min per IP, on all of `/api`);
  - `TRUST_PROXY`;
  - `SEED_RABBITMQ_*` (staging seed only).

  `RATE_LIMIT_SPEND`, `RATE_LIMIT_AUTH` and `RATE_LIMIT_METRICS` are now passed through
  in `docker-compose.yml`.

- **Moving a consumer from Tiltify:** follow `docs/outbound-events.md` § Consumer setup,
  in this order:
  1. Deploy.
  2. Point the REST URL at `<APP_BASE_URL>/api/tiltify/`.
  3. Switch RabbitMQ.

  kollekt needs esamarathon/kollekt#36 before two Channels of one Event take donations.

- **Webhook Destinations:**
  - `max_attempts` is gone. Endpoint failures retry forever, in order.
  - A Destination with a large backlog sends it all, in order, when it comes back.

### Added

- **Events** (#114, #115). An Event (a marathon) is the parent of its Channels (streams).
  - Every Event and Channel has a slug, and an Event has a primary Channel.
  - `/api/events` lists the public Events.
  - Admin and moderator Event management.
  - Donate URLs are `/donate/<event>/<channel>`.
- **Donation routing** (#115). A donation goes to:
  1. its pledge's Channel;
  2. else its Event's primary Channel;
  3. else the primary Channel of the only active Event;
  4. else it is left **unassigned**.

  An admin assigns an unassigned donation once, from the donations list.

- **Tiltify-compatible webhook messages** (#116, ADR-0009). A RabbitMQ Destination can
  use the `TILTIFY` payload format. It sends:
  - bare Tiltify donations on `<channel-slug>.donation`, with reward claims, poll votes
    and goal contributions;
  - Channel and Event totals on `<slug>.fact.updated`.
- **Hide from overlay** (#116). Moderators can take a donation off the stream overlay,
  and put it back. Native Destinations get `donation.hidden`, `donation.unhidden`, and
  `donor_name`, `donor_comment` and `event_id` on `donation.created`.
- **Tiltify-compatible REST API** at `/api/tiltify` (#117, ADR-0010). It serves
  `campaigns/{id}`, and rewards, targets, polls, milestones and matches, for kollekt and
  esa-layouts-v2.
- **Webhook queue operations** (#109, ADR-0007):
  - requeue one FAILED delivery, or all of them;
  - per-Destination metrics: queue depth, oldest pending age, failed count, last
    success and active;
  - a runbook in `docs/outbound-events.md`.
- **Per-Channel metrics** (#115):
  - `dono_*_by_channel{event,channel}`;
  - `dono_donations_unassigned`;
  - `dono_channels_active`.
- **Global per-IP API rate limit** `RATE_LIMIT_API`, and `TRUST_PROXY` (#140).
- CI:
  - CI and the security scan run on PRs into `dev`;
  - PRs into `dev` publish `:pr-<n>` images;
  - releases get immutable images (#122, #123).

### Changed

- **Webhook delivery** (#109, ADR-0007):
  - Strict first-in-first-out order per Destination, and a message is sent as soon as its
    change commits (transactional outbox).
  - Endpoint failures, including every HTTP 4xx, retry forever with backoff
    5/15/60/180 s.
  - Only a malformed message becomes `FAILED`.
  - SUCCESS rows are deleted after 2 h and FAILED rows after 24 h.
  - Each message has one `message_id`.
- **Webhook vocabulary** (#113, ADR-0006). "Event" now always means the charity event;
  webhook concepts are **message**, **Destination** and **Delivery**. The wire names
  (`X-Webhook-Event`, `event_types`, `event_type`) are unchanged.
- **Money totals** count COMPLETED and REFUNDED donations (refunds go to the donor's
  wallet). A chargeback lowers them. This applies to `/api/campaign`, admin stats,
  metrics and Tiltify totals.
- Channel management moved into shared admin and moderator Event/Channel routes.
- Documentation consistency review (#119):
  - CONTEXT.md glossary;
  - ADRs 0006–0010;
  - openapi auth schemes, with `?token=` removed from 44 operations;
  - staff help;
  - the Destinations page says "Destination" and "message types".

### Fixed

- **Security:** per-IP rate limits were shared by every visitor behind two proxies
  (#140).
- Concurrent transactions no longer deadlock on SQLite (one connection, 15 s wait).
- The staging seed no longer prints full API keys or magic links to the journal.
- A Tiltify reward claim without a custom answer sends `null`, not `"{}"`.

## [0.1.0] — 2026-09-27

First tagged release. It records the current state of `main` as a baseline. Work
continues on `dev`.

### Platform at this release

- **Donations through Stripe.** Hosted Stripe Checkout replaces Tiltify. A verified
  webhook credits the donor's wallet and fulfils the pledge. Physical rewards collect a
  shipping address on Stripe, and it is never stored here.
- **Smart donation cart.** A donor chooses rewards, poll votes and goal contributions
  before donating. Items can have a quantity. The cart has an additional-contribution
  field, a display name and a comment. The wallet balance is applied as a discount.
- **Channels.** Donations and incentives are scoped per Channel (stream), and each
  Channel has its own deep links.
- **Donor wallet.** Magic-link and OAuth (Google, Discord, Twitch) sign-in. The session
  is kept in an httpOnly cookie. The wallet shows donation history per Channel.
- **Moderation.** Roles are User, Moderator and Admin. Moderators get views of all
  donations, claims and custom poll entries, with human-readable pledge data.
- **Administration.** Admins get donor management, donation status (cleared, refunded,
  charged back), external donation entry, bulk credit sweep-out, unallocated-credit
  totals, a broadcast banner with severity levels, and feature flags.
- **Silent auctions.** Auctions use cascading Stripe Checkout settlement, gated behind a
  feature flag.
- **Outbound webhooks.** Webhooks are delivered over HTTP and RabbitMQ.
- **Operations.**
  - Prometheus `/api/metrics` and optional OpenTelemetry tracing.
  - A feedback widget that posts to Discord.
  - A seeded platform simulator, dev and staging seeds, and a nightly demo reset.
  - Multi-arch backend and frontend images on GHCR, with a Trivy gate and smoke test.

### Changes since the previous `main` snapshot (#71)

#### Added

- Broadcast banner, editable by admins, with severity levels (#61, #68).
- Feature-flag system that gates auctions (#69).
- Feedback widget: screenshot and text, sent to Discord.
- Dev seed with persistent moderator and admin accounts and a key banner.
- Admin:
  - bulk credit sweep-out (#60);
  - donation status and filter (#63);
  - "Add Donation" for donations received outside Stripe (#62);
  - aggregate unallocated credits (#59).
- Cart:
  - display name (#54);
  - item quantities (#50);
  - more prominent cart and donation amount (#51).
- Client:
  - Channel deep links (#49);
  - donation-impact overlay on poll and goal bars (#52);
  - animated global progress bar.
- Moderator: human-readable donor identity on claims (#57), and pledge data on
  donations (#58).
- Wallet shows the Channel of each donation (#53).
- Simulator v2: donor profiles, repeat donations, multi-item carts, phased traffic.

#### Fixed

- **Security:** the pledge return no longer exposes the donor magic token (#48).
- A Donation is now recorded when the wallet covers the whole pledge (#43).
- Scrolling of the admin sidebar, content and donor panes (#64); donor detail now shows
  donation history (#47).
- The donate flow refetches Channels when it opens (#46). Moderator poll actions show
  errors instead of failing silently (#45). A custom write-in that was already added can
  be edited (#44).
- The auctions nav link is hidden when the flag is off. The simulator tolerates disabled
  auctions.
- Seed and demo reset: the banner shows raw keys and login steps, and moderator and admin
  accounts are seeded again after a reset.

#### Changed

- Removed the fulfilment status toggle from the moderator claims view (#56).
- Docker images are published under `ghcr.io/esamarathon/esa-dono-ui`, with branch tags.
  CI and the security scan also run on `dev` pushes.
- Dependencies: multer, nodemailer and sharp bumped to fix HIGH Trivy CVEs.

[Unreleased]: https://github.com/esamarathon/esa-dono-ui/compare/0.2.0...HEAD
[0.2.0]: https://github.com/esamarathon/esa-dono-ui/releases/tag/0.2.0
[0.1.0]: https://github.com/esamarathon/esa-dono-ui/releases/tag/0.1.0
