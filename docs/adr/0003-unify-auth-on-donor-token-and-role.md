# 3. Unify Authorization on the Donor Token + Role

- Status: Accepted (implemented 2026-08-19)
- Date: 2026-08-17
- Author: TBD
- Deciders: TBD

## Summary

Make the donor magic token the single authorization token for every protected
endpoint, and derive permissions from the authenticated donor's _effective_ role
(`USER` / `MODERATOR` / `ADMIN`). `ADMIN_API_KEY` / `MODERATOR_API_KEY` remain
only as an operational fallback (scripting, bootstrapping), never the primary
path.

## Context

Three parallel authorization mechanisms exist today:

| Surface                                         | Middleware      | Token                                                       |
| ----------------------------------------------- | --------------- | ----------------------------------------------------------- |
| `/api/donor`, rewards/polls/goals/events/pledge | `donorAuth`     | `?token=` (donor magic token)                               |
| `/api/moderator`                                | `moderatorAuth` | `X-Admin-Key` / `X-Moderator-Key` **or** donor token + role |
| `/api/admin`                                    | `adminAuth`     | `X-Admin-Key` only (never accepts donor token)              |

The role→permission machinery already exists: `donorAuth` resolves
`req.donor.role` per-request via `resolveEffectiveRole()`
(`server/lib/roles.ts`), which re-checks the `ADMIN_EMAILS`/`MODERATOR_EMAILS`
allowlists (gated on `email_verified`) without ever downgrading the persisted
role. `hasModeratorAccess()` / `hasAdminAccess()` encode the permission mapping.

The symptom that prompted this: an `ADMIN`-role donor follows the "admin" link in
the user menu (`client/src/components/UserMenu.tsx`, shown when
`hasAdminAccess(role)`) to `/admin`, but `AdminLayout` only checks
`localStorage.admin_key`, so it prompts for an API key despite the donor being an
admin.

## Decision

Adopt the donor token + effective role as the primary authorization mechanism for
all endpoints, with the API keys retained as fallback only.

- `/api/admin` is gated by `donorAuth` + `hasAdminAccess(req.donor.role)`, with
  `X-Admin-Key` matching `ADMIN_API_KEY` accepted as a fallback — exactly the
  pattern `moderatorAuth` already uses for moderator routes.
- `/api/moderator` is unchanged (it is already role-primary with key fallback).
- Client: `client/src/api/admin.ts` attaches `?token=` (as `moderator.ts` does);
  `AdminLayout` gates on the donor's role (as `ModeratorLayout` does), keeping the
  admin-key entry as a fallback.
- Bootstrap: the first admin logs in via a verified OAuth provider whose email is
  on `ADMIN_EMAILS`, earning the `ADMIN` role at request time; they can then grant
  persisted roles via `PATCH /api/admin/donors/:id/role`.

## Alternatives Considered

1. **Remove the API keys entirely (role-only)**
   - Pros: single token, no parallel backdoor path.
   - Cons: breaks `smoke-test.sh`, `seed-dev.sh`, and scripts that authenticate
     with a key; removes the operational fallback for environments that cannot
     arrange a verified OAuth login for the first admin.
   - Rejected for now: chosen to retain keys as fallback; can be removed later.

2. **Keep keys primary, role secondary**
   - Pros: minimal change.
   - Cons: does not satisfy "same token set for authorization"; the admin-donor
     UX bug remains.
   - Rejected.

3. **Status quo**
   - Rejected: three token sets, and admin donors cannot reach `/admin`.

## Consequences

- Benefits: one authorization token; permissions derive from the user's role; the
  admin menu link works for admin-role donors; fewer client-side key stores.
- Trade-offs: two paths can grant the same privilege (a role, or a leaked key).
  The bootstrap path depends on `ADMIN_EMAILS` + a verified OAuth login.
- Risks:
  - A leaked `ADMIN_API_KEY` still grants full admin — mitigate by keeping keys
    secret and documenting them as fallback-only.
  - Role allowlists are gated on `email_verified`; an admin who only ever uses
    magic-link email login (unverified) won't bootstrap. Mitigate by documenting
    the OAuth requirement for first-boot.

## Implementation

- Prerequisites: none beyond existing env (`ADMIN_EMAILS`, OAuth providers).
- Steps:
  1. Rewrite `server/middleware/adminAuth.ts` to try `donorAuth` +
     `hasAdminAccess` first, then fall back to `X-Admin-Key` (mirroring
     `moderatorAuth`).
  2. `server/routes/admin.ts`: no handler changes; `router.use(adminAuth)` now
     admits role-based requests.
  3. `client/src/api/admin.ts`: attach `?token=` (and `X-Admin-Key` when
     `admin_key` is stored).
  4. `client/src/pages/admin/AdminLayout.tsx`: gate on donor role via `getDonor()`
     - `hasAdminAccess`, keeping key fallback.
  5. Update `server/test/middleware/adminAuth.test.ts` and add role-based cases
     to `server/test/routes/admin.test.ts` (existing `x-admin-key` tests continue
     to pass via fallback).
  6. Update `server/openapi.yaml`, `CLAUDE.md`, and `README.md` auth descriptions.
- Success criteria: `npm run typecheck`, `npm test`, and `scripts/smoke-test.sh`
  pass; an `ADMIN`-role donor can reach `/admin` without a key; `X-Admin-Key`
  still works for scripting.
- Reversibility: git revert; the change is additive (role path added, keys
  retained), so no data migration or rollout ordering concern.
