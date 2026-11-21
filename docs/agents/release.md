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
- **No version bump ever lands on `dev`.** The manifests stay at the last
  released version.

## Lane 2 — the release PR (`dev` → `main`)

Merging to `main` is the only release act. The PR carries exactly:

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

The CI `release-guard` job fails the PR unless: all six version fields agree,
the version is greater than the latest bare tag, `## [x.y.z]` exists with a
`— YYYY-MM-DD` date and bullet points, and `## [Unreleased]` is empty. After
the merge, `tag-version` in `docker-publish.yml` tags `<version>` on main (and
`<version>-dev` on dev), promotes the `:sha` images, and publishes the GitHub
Release from the matching changelog section.

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
