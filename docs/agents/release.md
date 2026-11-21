# Release flow

How a change travels from a PR to a tagged release. The rule in one sentence:
**`dev` accumulates changelog bullets; the `dev` → `main` merge is the release
gate and must bump every version field and carry the matching changelog
section.**

## Lane 1 — PRs into `dev`

- Every PR that changes code under `server/`, `client/` or `packages/` adds one
  bullet under `## [Unreleased]` in `CHANGELOG.md` (`Added` / `Changed` /
  `Fixed`). The CI `changelog` job fails the PR otherwise.
- Label the PR `no-changelog` to opt out (docs, tests-only, CI plumbing).
  Renovate PRs carry `dependencies` + `no-changelog` and are exempt by rule:
  dependency bumps get one `Dependencies` bullet in the next release section
  instead of one line per PR.
- **No version bump in feature/fix PRs.** The only version change on `dev` comes
  from the release prepare PR in Lane 2.

## Lane 2 — release: prepare on `dev`, gate on `main`

A release is two merges, in this order (this matches the 0.4.0 history: #242
prepared on `dev`, #243 was the gate):

1. **Prepare PR into `dev`** (`chore/release-x.y.z`, titled `Release x.y.z`):
   run `npm run release`, commit the six version fields plus the changelog
   rewrite. On merge, `tag-version` tags `x.y.z-dev` on the dev push.
2. **Gate PR `dev` → `main`** (titled `Release x.y.z`): its diff carries the
   version bump and the dated section. On merge, `tag-version` tags `x.y.z`,
   promotes the `:sha` images to `:x.y.z`, and publishes the GitHub Release from
   the matching changelog section.

The release PR carries exactly:

1. the version bump in all six fields — root/server/client/packages.shared
   `package.json`, `package-lock.json` (root + workspace entries),
   `server/openapi.yaml` `info.version`;
2. `## [Unreleased]` rewritten to `## [x.y.z] — YYYY-MM-DD`, with a fresh empty
   `## [Unreleased]` left on top.

Prepare it with:

```bash
npm run release            # pick the version from commit types since the last tag
npm run release -- 0.5.0   # explicit version
```

The script rewrites all six fields (never by string replace — third-party
packages can share the version string), moves the Unreleased bullets under the
new dated heading, then verifies the result with the same checks CI runs.

The CI `release-guard` job fails the gate PR unless: all six version fields
agree, the version is greater than the latest bare tag, `## [x.y.z]` exists with
a `— YYYY-MM-DD` date and bullet points, and `## [Unreleased]` is empty. Cut the
gate PR right after the prepare merge — a dev PR that lands in between adds
bullets to `## [Unreleased]` again and the gate fails until they are moved.

### Bump rule (0.x, `main` = what gets deployed)

| Unreleased content                         | Bump  |
| ------------------------------------------ | ----- |
| `Fixed` and dependency bullets only        | patch |
| Any `Added` / `Changed`                    | minor |
| Breaking change (pre-1.0 minors may break) | minor |
| plus an `Upgrade notes` subsection         |       |

`npm run release` derives this from commit subjects since the last tag
(`feat…` → minor, otherwise patch) and refuses a lower version unless
`--force`.

## Renovate (dependencies)

- Targets `dev` (`baseBranches`), weekly Monday run, `minimumReleaseAge: 3 days`
  so no version younger than three days is proposed.
- Patch/digest/pin updates are grouped into one PR and automerge
  (`platformAutomerge`); `lockFileMaintenance` is enabled and automerges too.
  Minor/major updates stay individual, manual PRs.
- `rebaseWhen: behind-base-branch` keeps stale grouped PRs from rotting.
- Security updates come from OSV lookups (`osvVulnerabilityAlerts`) instead of
  repo Dependabot alerts (`vulnerabilityAlerts.enabled = false`). Renovate runs
  on the workflow's `GITHUB_TOKEN` (there is no `RENOVATE_TOKEN` secret), and
  that token cannot read the Dependabot-alerts API — there is no matching
  Actions `permissions:` key — so OSV is the only source of alert coverage.

Repo settings this depends on: **Allow auto-merge** must be enabled on the
repository. Branch protection on `main` with required checks is recommended so
automerge and the release gate cannot be bypassed by a direct push.

## If the checks fail

- _version fields disagree_ — run `npm run release -- x.y.z` again; it writes
  all six locations.
- _CHANGELOG.md has no `## [x.y.z]` section_ — the release notes are missing;
  `tag-version` refuses an empty GitHub Release page for the same reason.
- _`## [Unreleased]` still has bullet points_ — the release PR moved nothing;
  bullets must live under the dated heading at merge time.
