# ADR-0001: Adopt TypeScript for Frontend and Backend

| Field        | Value      |
| ------------ | ---------- |
| **Status**   | Accepted   |
| **Date**     | 2026-07-25 |
| **Author**   | TBD        |
| **Deciders** | TBD        |

---

## Summary

The project was originally written in plain JavaScript (ESM) across both the
React/Vite client and the Express/Prisma server. We will migrate both workspaces
to TypeScript with `strict` mode, sharing domain and API-contract types through a
new `packages/shared` workspace. The migration is incremental (file-by-file,
leaf→root), server first, keeping the app runnable and tests green throughout.

---

## Context

### Background

At the time of this decision the repository contained ~86 source files (54 client
`.jsx`/`.js`, 32 server `.js`) with:

- No `tsconfig`, no `typescript` dependency, no `@types/*` packages.
- Both workspaces on ESM (`"type": "module"`).
- Client built by Vite (which compiles `.tsx` natively, no bundler change needed).
- Server run as raw Node ESM (`node --watch index.js`) with **no build step**.
- Vitest per workspace (supports TS natively).
- Prisma already generating a fully typed client — whose types are entirely unused
  in plain JS.

### Problem Statement

The highest-risk surfaces have no static type safety:

- **Money is integer cents everywhere** (`balance_remaining`, `total_cents`,
  `amount_cents`) — cents/dollars mixups are silent at runtime.
- **`RewardClaim.claim_data` is a hand-parsed JSON string** (SQLite has no JSON
  column) typed as `any`.
- **Tiltify webhook payloads** are hand-parsed external JSON with no schema.
- **Shared service layer** (`processDonation`, `resolvePledge`, `fulfillPledge`,
  the `tx`-aware spend helpers) is refactored by grep + tests only.
- **Middleware-attached state** (`req.donor`, `req.donor.is_moderator`) is invisible
  to consumers.

### Constraints

- Must keep Prisma (backbone of atomic balance mutations and the spend helpers).
- Must preserve monorepo code sharing between client and server.
- Should avoid a big-bang rewrite; app and tests must stay green at each step.
- Should minimize changes to the existing Docker/CI deployment pattern.

---

## Decision

### Chosen Option

**Migrate both workspaces to TypeScript (`strict`), with shared types in a
`packages/shared` workspace, incrementally and server-first.**

### Rationale

- **Type safety where it matters** — brands money as `Cents`, types webhook
  payloads and `claim_data`, and surfaces nulls that are currently implicit.
- **Amplifies existing Prisma types** — the single biggest ROI; Prisma is already
  in the stack and its types are free once TS is enabled.
- **Preserves the ecosystem** — Express, Nodemailer, axios, Vitest, and the whole
  monorepo remain; no rewrite.
- **Low structural friction** — Vite compiles TSX natively; the server uses `tsx`
  to keep today's zero-build dev ergonomics.

### Decision Drivers

- Type safety and maintainability (the actual goal), not runtime performance.
- Reuse of already-generated Prisma types.
- Keeping client↔server contract in sync via shared types.

---

## Alternatives Considered

### Option A: Stay on plain JavaScript — ✗ Not Chosen

Keep the status quo.

**Pros:** No migration cost; no build step on server; smallest toolchain.

**Cons:** No static type safety on money/webhooks/`claim_data`; Prisma types
unused; refactoring relies on grep + tests.

---

### Option B: TypeScript (strict) everywhere — ✓ Chosen

Migrate both workspaces incrementally; shared types package; `tsx` on the server.

**Pros:** Strong type safety; leverages Prisma types; keeps ecosystem and monorepo
sharing; incremental via `allowJs`; Vite needs no config change.

**Cons:** Adds a `tsc --noEmit` typecheck step and `tsconfig` per workspace; ~86
files to migrate; `strict` surfaces real latent nulls/`any` (that is the point).

---

### Option C: Go backend — ✗ Not Chosen

Rewrite the server in Go, keep the JS client.

**Pros:** Strong types; single static binary; excellent concurrency.

**Cons:** Solves a problem this app does not have (throughput is webhook/admin-scale,
I/O-bound, no CPU-bound work). Throws away Prisma (no equivalent ergonomics),
severs monorepo type-sharing with the React client, and is a full rewrite of every
service, route, and the raw-body HMAC webhook handling — very high cost, no
proportional benefit.

---

### Option D: JSDoc + `checkJs` (no file renames) — ✗ Not Chosen

Enable `// @ts-check` + JSDoc types with `checkJs` in a `tsconfig`.

**Pros:** Much of the type-checking and IDE support (incl. Prisma types) with **no**
renames and **no** build step; cheapest middle ground.

**Cons:** Verbose JSDoc annotations; weaker ergonomics than real TS; no shared
compiled types package; tends to stall as a permanent half-measure.

---

### Comparison

| Criterion             | A: Plain JS | B: TypeScript     | C: Go     | D: JSDoc |
| --------------------- | ----------- | ----------------- | --------- | -------- |
| Type safety           | None        | High              | High      | Med      |
| Keeps Prisma          | Yes         | Yes               | **No**    | Yes      |
| Monorepo type sharing | Partial     | High              | None      | Partial  |
| Migration cost        | None        | Low (incremental) | Very High | Very Low |
| Team familiarity      | High        | High              | Low       | High     |

---

## Consequences

### Benefits

- **Compile-time safety** on money, webhook payloads, and `claim_data`.
- **Free Prisma type checking** across services, routes, and middleware.
- **Safer refactoring** of the shared service layer (every caller flagged).
- **In-sync client↔server contract** via `packages/shared`.
- **Better IDE/agent navigation** (autocomplete, go-to-definition, typo catching).

### Trade-offs

- New `tsconfig` per workspace and a `typecheck` CI gate.
- Server gains `tsx` in its runtime path (still no separate build artifact).
- Up-front effort to resolve `strict` violations in previously-untyped code.

### Risks

| Risk                                             | Impact | Likelihood | Mitigation                                            |
| ------------------------------------------------ | ------ | ---------- | ----------------------------------------------------- |
| `strict` surfaces many latent issues at once     | Med    | High       | Incremental `allowJs`, file-by-file; keep tests green |
| Docker/prod boot breaks from runtime change      | High   | Low        | Re-run `scripts/smoke-test.sh` after server phase     |
| Shared package fails to resolve in Docker images | Med    | Low        | Verify workspace hoisting in both images              |

---

## Implementation

### Prerequisites

- Migration branch `migrate/typescript`.
- Green baseline (`npm test`, `npm run lint`).

### Steps

1. **Phase 0** — Root `tsconfig.base.json` (`strict`, `allowJs`); add `typescript`;
   create `packages/shared` workspace; migrate ESLint to `typescript-eslint`; add
   `typecheck` scripts.
2. **Phase 1 (server first)** — Add `tsx` + `@types/*`; server `tsconfig`; scripts to
   `tsx`; migrate leaf→root (`lib` → `services` → `middleware` w/ `req.donor`
   augmentation → `routes` → `index` → tests); move webhook/`claim_data`/`Cents`
   types into `packages/shared`.
3. **Phase 2 (client)** — Add `@types/react*`; client `tsconfig`; migrate `utils`/`api`
   → `.ts`, `components`/`pages` → `.tsx`, `main` → `.tsx`, `index.html` script src;
   depend on `packages/shared`.
4. **Phase 3** — CI `typecheck` gate; update `Dockerfile.backend` for `tsx`; re-run
   `scripts/smoke-test.sh`; remove `allowJs`; update `CLAUDE.md`.

### Success Criteria

- [ ] `npm test` green in both workspaces.
- [ ] `npm run typecheck` clean under `strict`.
- [ ] `npm run lint` clean.
- [ ] `scripts/smoke-test.sh` passes against runtime images.
- [ ] No `.js`/`.jsx` source or test files remain; `allowJs` off (only `*.config.js` excepted).

### Reversibility

**Can this be reversed?** Partially. During the migration, `allowJs` keeps `.js`
and `.ts` interoperating, so the branch can be paused or partially shipped. A full
revert after completion would require reverting the branch; in practice the
decision is expected to be permanent.

---

## References

- **Root `package.json` / `client/package.json` / `server/package.json`** — original JS setup.
- **`CLAUDE.md`** — architecture and command reference (updated in Phase 3).
- **Prisma** — https://www.prisma.io/docs (typed client rationale).
