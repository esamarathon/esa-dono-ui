# 4. Move Auth Transport to `Authorization: Bearer` and Fix Credential Holding

- Status: Accepted (implemented — see Implementation Outcome)
- Date: 2026-08-18
- Author: TBD
- Deciders: TBD

> **Implementation outcome (2026-08-18).** Because the app was pre-production, we
> enacted the _stronger_ end state directly rather than the incremental one: the
> browser donor credential now lives in an **httpOnly `dono_session` cookie**
> (Alternative 2), and the legacy transports (`?token=` query param,
> `X-Admin-Key`/`X-Moderator-Key` headers) were **removed outright** with no
> deprecation window. `Authorization: Bearer` remains the transport for
> non-browser donor auth and for the operational admin/moderator keys
> (`key_admin_`/`key_mod_` prefixes). Magic links now land on
> `GET /api/auth/magic` (server sets the cookie, redirects to `/wallet`) and the
> OAuth callback sets the cookie server-side, so the token never reaches the SPA
> URL. A JS-readable, non-secret `donor_session_active` marker drives UI state
> only. SameSite=Lax + same-origin API is the CSRF control (no state-changing GET
> endpoints). This closes XSS token theft, which the Bearer-only plan below did
> not.

## Summary

Stop transmitting the donor magic token in the `?token=` query string and stop
using bespoke `X-Admin-Key` / `X-Moderator-Key` headers for the operational
keys. Carry every credential in a single `Authorization: Bearer <token>` header,
using a token namespace prefix so the server can tell a donor magic token from an
operational key. Keep the DB-backed token (identity + per-request role
resolution) — do **not** put permissions in a self-contained JWT. Separately,
strip the landing token from the URL after capture to stop history/referrer
leakage.

This builds on ADR 0003 (unify authorization on the donor token + role); 0003
settled _what_ authorizes a request (donor token + effective role, keys as
fallback), this ADR settles _how the credential is transported and held_.

## Context

Two problems remain after ADR 0003:

1. **Transport is inconsistent and leaky.** The donor token rides in the query
   string (`client/src/api/client.ts` appends `?token=`; `donorAuth` reads
   `req.query.token`). Query strings leak into access logs, browser history,
   and `Referer` headers. The operational keys use two custom headers
   (`X-Admin-Key`, `X-Moderator-Key`), so a request may authenticate three
   different ways across three surfaces.

2. **Credential holding is XSS-exposed.** The token lands via `/wallet?token=…`
   (magic link email and OAuth callback, `server/routes/auth.ts:159`) and is
   persisted to `localStorage.donor_token`. It stays in the URL bar (history,
   `Referer`) and is readable by any injected script.

The delivery mechanism itself is not in question: a magic link _is_ a URL
carrying a token, and OAuth redirects likewise. This ADR does not change how the
user first receives the credential — only how the client captures, holds, and
retransmits it.

### Why not a permissions JWT

A self-contained JWT carrying `role`/permission claims was rejected: it defeats
the per-request revocation invariant that `resolveEffectiveRole()`
(`server/lib/roles.ts`) exists to provide. Removing an email from
`ADMIN_EMAILS`/`MODERATOR_EMAILS`, freezing an account (`is_frozen`), or rotating
a token must take effect on the _next_ request. Stale claims in a 30-day token
would require a revocation list that re-introduces the DB lookup we already do.
Identity-only JWTs (`sub: donorId`, no permissions, role re-resolved from the DB
each request) are an acceptable future variant but out of scope here.

## Decision

Adopt `Authorization: Bearer` as the single credential transport, keep the
server-side DB lookup, and de-risk credential holding.

- **Transport.** All clients send `Authorization: Bearer <token>`. A namespace
  prefix disambiguates credential type without a DB probe:
  - `Bearer <hex>` or `Bearer donor_<hex>` — donor magic token → `donorAuth`
  - `Bearer key_admin_<key>` — operational admin key (fallback)
  - `Bearer key_mod_<key>` — operational moderator key (fallback)
    Server middleware parses the scheme, strips the prefix, and dispatches to the
    existing resolution (magic-token DB lookup, or constant-time key compare).
    Query-string `?token=` is accepted for a deprecation window, then removed.

- **Holding.** On landing at `/wallet?token=…`, the client reads the token,
  immediately `history.replaceState`s it out of the URL, and stores it. This
  ADR keeps `localStorage` (Bearer transport requires JS-readable storage);
  moving to an httpOnly session cookie is deferred to a follow-up (see
  Alternatives 2) because it changes the transport model and needs CSRF work.

- **Delivery.** Unchanged. Magic link email and OAuth callback still redirect to
  `/wallet?token=…`; only the post-landing handling changes.

## Alternatives Considered

1. **Keep query param + custom headers (status quo transport)**
   - Pros: zero change.
   - Cons: token leaks via URL logs/history/`Referer`; three auth styles.
   - Rejected.

2. **httpOnly Secure SameSite session cookie (exchange magic token for a session)**
   - Pros: credential unreadable by JS — the only option that actually defends
     against XSS token theft; browser attaches it automatically.
   - Cons: cookie transport, not a `Bearer` header, so it does not satisfy the
     "single `Authorization` header" goal for the browser; requires CSRF
     protection; larger change.
   - Deferred: strongest security answer, but out of scope. Recommended as the
     follow-up if XSS token theft enters the threat model. Bearer keys still
     needed for scripts regardless.

3. **Self-contained JWT with permission claims**
   - Rejected: breaks per-request revocation (see Context → Why not a permissions
     JWT).

## Consequences

- Benefits: one credential header across all surfaces; the donor token leaves
  the query string (no more log/history/`Referer` leakage of the live token);
  per-request revocation and role resolution preserved unchanged.
- Trade-offs: `localStorage` still exposes the token to XSS — this ADR reduces
  URL-based leakage but does not close XSS token theft (Alternative 2 does).
  A prefix scheme is a mild convention consumers must follow.
- Risks:
  - A deprecation window accepting both `?token=` and `Authorization` widens the
    surface until the query path is removed — bound it with a target release.
  - Prefix parsing must be strict (reject unknown schemes) so a malformed
    `Authorization` never silently falls through to an unauthenticated handler.

## Implementation

- Prerequisites: ADR 0003 landed (admin route accepts donor token + role).
- Steps:
  1. Server: add an `Authorization` parser (scheme + prefix → credential type).
     Update `donorAuth` to read the Bearer donor token (query param still
     accepted during deprecation), and `moderatorAuth`/`adminAuth` to accept
     `key_admin_`/`key_mod_` Bearer keys alongside the existing `X-*` headers.
  2. Client: `client/src/api/client.ts`, `admin.ts`, `moderator.ts` attach
     `Authorization: Bearer <prefixed token>` instead of `?token=` / `X-*`.
  3. Client: `MyWallet.tsx` (and OAuth landing) capture `?token=` then
     `history.replaceState` to remove it from the URL before persisting.
  4. Tests: extend `server/test/middleware/*` for Bearer parsing (donor token,
     each key type, malformed/unknown scheme rejected); update client api tests
     (`client/test/api/*`) for the header.
  5. Docs: update `server/openapi.yaml` security schemes, `CLAUDE.md`, `README.md`.
  6. Deprecation: after clients ship, remove query-string `?token=` acceptance
     and the `X-Admin-Key`/`X-Moderator-Key` headers in a named follow-up release.
- Success criteria: `npm run typecheck`, `npm test`, and `scripts/smoke-test.sh`
  pass; a donor authenticates with `Authorization: Bearer`; the live token no
  longer appears in the URL after landing; unknown Bearer schemes 401.
- Reversibility: additive during the deprecation window (both transports work),
  so revertable by git revert with no data migration.
