---
description: Work the next decision ticket on a wayfinder map with the driving dev
argument-hint: '<map-number> [ticket-number]'
---

Work through the wayfinder map #$1 on `esamarathon/esa-dono-ui`, in "work through the map" mode.
Ticket: ${2:-the first frontier ticket in map order}. Resolve one ticket this session.

Read the wayfinder skill at
`~/.pi/agent/git/github.com/mattpocock/skills/skills/engineering/wayfinder/SKILL.md` (it is not
model-invocable, so read the file), then load the grilling and domain-modeling skills. Every
tracker command comes from `docs/agents/issue-tracker.md` § Wayfinding operations.

Keep every working file in the scratch directory `~/.cache/pi-scratch/$PI_SESSION_ID/`.

1. **Orient.** Read the map body, including its Notes and Finish-line carry list. Report
   `git status --short` and `git log --oneline origin/dev..dev`, naming any uncommitted
   `CONTEXT.md` edits. Done when the repo state is reported.
2. **Claim.** Run the frontier query and assign the chosen ticket to `@me` before any other
   write. Done when the assignee reads back from GitHub.
3. **Read.** Fetch fresh from GitHub: the ticket, every resolution it builds on, and each of their
   "Amended by" comments. Also read `CONTEXT.md`, `docs/agents/domain.md` and the ADRs that touch
   the area. Save copies in the scratch directory. Done when every linked resolution and
   amendment is read.
4. **Facts.** Check in the code every fact a question will rest on. For any endpoint or response
   field, check `docs/api-consumers.md` and confirm with its `rg -uu` command. Record them in
   `facts.md`. Done when no planned question rests on an unchecked fact.
5. **Grill.** Ask one question per `ask_user` call, and write the full question in the chat
   message too (the form is sometimes not visible; `detail` holds at most 1000 characters).
   - Each question has a concrete dollar example, the options, and your recommendation, worded so
     "yes" accepts it.
   - A cancelled or unanswered form is no decision. A clarification request gets an explanation
     (risks, terms, a worked example), then the same question again.
   - Log each answer in `decisions.md` as it lands. Update `CONTEXT.md` inline when a term settles.

   Done when every point in the ticket's Question has a decision and no branch of the design tree
   is left open.

6. **Verify.** Write `resolution-draft.md`. Cross-check it against the earlier resolutions and the
   code, and list the items you derived rather than asked. Offer a read-only review by a subagent
   on model `gpt-6-astra`, spot-check its citations, and put each finding that needs a decision
   to the dev one at a time. Done when the dev confirms the final draft.
7. **Record.** Follow `docs/agents/issue-tracker.md`: resolution comment, close, one
   Decisions-so-far line (by ticket name, with the safe map edit), "Amended by" on every ticket
   the decision changes, and a Finish-line carry list entry for any new conflict with existing
   docs or ADRs. Commit `CONTEXT.md` only when the dev asks. Done when every post reads back
   from GitHub.
8. **Hand off.** Report what was posted, the repo state and any side findings. Give the next
   prompt: `/wayfind-next $1`, plus only what the map cannot hold.
