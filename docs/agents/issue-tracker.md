# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `Codescales/esa-dono-ui`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

GitHub Issues has no first-class parent/child or blocking relationship exposed through `gh`, so wayfinder expresses its structure with labels and a body convention.

- **The map** is an issue labelled `wayfinder:map`. Find it with `gh issue list --label wayfinder:map --state open`.
- **A ticket** is a child issue labelled `wayfinder:ticket` plus its type label (`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`). Link it to its map by putting `Map: #<map-number>` on the first line of the body.
- **Blocking** is a body convention: a ticket lists `Blocked by: #12, #13` near the top of its body. A ticket is unblocked when every issue it lists as a blocker is closed.
- **Claiming** a ticket = assigning it: `gh issue edit <n> --add-assignee @me`. An open, unassigned ticket is unclaimed.
- **The frontier** = open `wayfinder:ticket` issues that are unassigned and have no open blockers. Query open tickets with `gh issue list --label wayfinder:ticket --state open --json number,title,body,assignees`, then filter out any whose `Blocked by:` references are still open.
- **Resolving** a ticket = post a resolution comment, `gh issue close <n>`, then append a one-line context pointer to the map body's "Decisions so far".

Required labels (create once): `wayfinder:map`, `wayfinder:ticket`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
