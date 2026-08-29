# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (if present).
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md          ← not yet created; created lazily by /grill-with-docs
├── docs/adr/
│   ├── 0001-typescript-for-frontend-and-backend.md
│   ├── 0002-migrate-payments-tiltify-to-stripe.md
│   ├── 0003-unify-auth-on-donor-token-and-role.md
│   ├── 0004-bearer-token-transport-and-credential-holding.md
│   └── 0005-outbound-webhooks.md
└── ...
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (unify auth on donor token and role) — but worth reopening because…_
