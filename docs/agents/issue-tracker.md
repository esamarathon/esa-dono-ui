# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in **`esamarathon/esa-dono-ui`**, managed via the `gh` CLI.

> **Where issues live.** `origin` is `esamarathon/esa-dono-ui`, where issues are
> enabled and triaged. Push branches to `origin`. `gh` resolves the repo from `origin`
> automatically.

## Conventions

- **Create an issue**: `gh -R esamarathon/esa-dono-ui issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh -R esamarathon/esa-dono-ui issue view <number> --json number,title,body,labels,comments`, filtering by `jq`. The `--comments` flag fails here (Projects-classic GraphQL deprecation). REST also works: `gh api repos/esamarathon/esa-dono-ui/issues/<number>` and `gh api --paginate repos/esamarathon/esa-dono-ui/issues/<number>/comments`.
- **List issues**: `gh -R esamarathon/esa-dono-ui issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh -R esamarathon/esa-dono-ui issue comment <number> --body "..."`
- **Apply / remove labels**: `gh -R esamarathon/esa-dono-ui issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh -R esamarathon/esa-dono-ui issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `esamarathon/esa-dono-ui`.

## When a skill says "fetch the relevant ticket"

Run `gh -R esamarathon/esa-dono-ui issue view <number> --json number,title,body,labels,comments` (see "Read an issue").

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/esamarathon/esa-dono-ui/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/esamarathon/esa-dono-ui/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children in map order with `gh api "repos/esamarathon/esa-dono-ui/issues/<map>/sub_issues?per_page=100" --jq '.[] | select(.state=="open") | [.number, (.assignees|map(.login)|join(",")), .issue_dependencies_summary.blocked_by, ([.labels[].name]|join(",")), .title] | @tsv'`. Drop any with an open blocker (`blocked_by > 0`, or an open issue in the `Blocked by` line), an assignee, or the `wayfinder:deferred` label; first in map order wins.
- **Deferred child**: an implementation issue attached to the map that starts after the destination is reached carries `wayfinder:deferred`. It stays a sub-issue for visibility but is never on the frontier. The map's Notes say why.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: post the answer from a file (`gh api repos/esamarathon/esa-dono-ui/issues/<n>/comments -F body=@answer.md`), close it (`gh api -X PATCH repos/esamarathon/esa-dono-ui/issues/<n> -f state=closed -f state_reason=completed`), then append a context pointer (gist + link) to the map's Decisions-so-far.
- **Edit the map body**: other sessions edit the map concurrently. Save `gh api repos/esamarathon/esa-dono-ui/issues/<map> --jq .body` to a file, edit a copy, re-fetch and compare with the saved file just before `gh api -X PATCH repos/esamarathon/esa-dono-ui/issues/<map> -F body=@new.md`; on any difference, redo the edit on the fresh body.
