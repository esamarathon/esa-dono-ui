# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can contain
breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/esamarathon/esa-dono-ui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/esamarathon/esa-dono-ui/releases/tag/v0.1.0
