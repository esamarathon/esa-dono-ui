# PRD: Amount-First Donation Flow with Per-Category Incentive Pools

Triage: `ready-for-agent` (per child issue, after slicing; see "Work Breakdown")
Origin: wayfinder map esamarathon/esa-dono-ui#151. It supersedes #74 ("Cart paradigm") and #79 ("Cross-incentive spending"); #75 and #133 were closed as superseded.
Related: [ADR-0011](../adr/0011-pooled-allocation-accounting.md) (accounting model), [ADR-0009](../adr/0009-tiltify-compatible-messages.md) (amended in part), [ADR-0010](../adr/0010-tiltify-compatible-rest-api.md), `docs/prd/0002-outbound-webhook-queue-and-tiltify-compatibility.md`, `CONTEXT.md` § Money and incentives

Each section cites the map ticket that decided it, for example (#159). The ticket's resolution comment and its "Amended by" comments are the full record. When this PRD and a ticket disagree, the later amendment wins. Report the conflict on the slice's issue.

## Problem Statement

Today a donor builds a cart of incentives on `/donate`, then pays for it. One dollar can be spent once (`server/services/spend.ts`). This causes these problems:

- **Donors must choose how to split their money.** A $10 donor who wants a reward, a poll vote and a goal must divide $10 between them. Tiltify, the system the stream audience knows, counts one donation toward a reward, a poll and a target together (#152).
- **The cart has no amount.** The donor adds items and the total follows. The "additional contribution" (`top_up_cents`) is a separate field. The wallet discount offsets items but not the additional contribution. A Previous/Next stepper and a "you haven't reviewed X yet" reminder push the donor through every tab (#133).
- **Money that no incentive uses stays in the wallet** as `balance_remaining`. Most donors never spend it, so poll and goal totals miss money that the donor gave.
- **Several money bugs exist:**
  - wallet-only donations count twice toward the money total (#158);
  - the `REFUNDED` status takes credit out of the wallet instead of returning it (#163);
  - the Stripe webhook puts shipping into `amount_cents` and `total_donated` (`server/routes/webhook.ts:67-68`);
  - admin reverse-spend gives back the live reward price, not the price paid (`server/routes/admin.ts:724`).

## Solution

1. The donor first states a **Pledge amount**. Each incentive category (rewards, polls, goals) gets its own **Pool** equal to that amount. $10 allows $10 of rewards **and** $10 of poll votes **and** $10 of goal contributions. Each incentive's progress goes up by its allocation. The **Money total** goes up only by the money paid.
2. Inside a Pool the donor can split money across several polls, options or goals, or claim several rewards. A category above the pledge amount shows a warning and a one-click "raise my donation to $X". Checkout is blocked until it fits.
3. Poll and goal money that the donor does not direct is **auto-allocated**: first to the donor's own selections in that category, and then (goals only) to the Channel's **Default goal list**. Polls have no default. What remains is **Unused pool money**, which a moderator can assign.
4. Reversals give **Pool credit** in the category, not Wallet credit. The donor spends it on a new credits page. Physical rewards can be cancelled with a **Payment refund** to the original payment method.
5. Staff pages, stats and metrics show incentive amounts apart from money, and never add them together.
6. The change ships between Events as a hard switch, with a transition runbook.

The accounting rules are in ADR-0011. This PRD does not repeat them in full.

## Glossary

The terms are in `CONTEXT.md` § Glossary and § Money and incentives:

- **Pledge amount**, **Draft pledge**, **Pending pledge**
- **Pool**, **Auto-allocation**, **Default goal list**
- **Wallet credit**, **Pool credit**, **Unused pool money**
- **Wallet refund**, **Payment refund**, **Chargeback**
- **Money total**
- **Event**, including its explicit end

Use them in code, UI text, issues and docs. Avoid "refund" alone, "top-up", "cart", "declared amount", "balance" alone and "leftover".

"Donation without a pledge" is a phrase, not a term. It means a donation with no pledge amount: an admin-added, external (#62) or pre-change donation, or a late payment for an old-shape pledge.

**Allocation source** (`source`) is the field on a poll vote or goal contribution row: `donor` (the donor chose it), `auto` (auto-allocation) or `moderator` (a moderator assigned Unused pool money).

## User Stories

1. As a donor, I state how much I give first, so that I know my total before I choose incentives.
2. As a donor, I can give $10 and have it count toward a reward, my poll vote and a goal together, as on Tiltify.
3. As a donor, I can split my poll money across several options, and my goal money across several goals.
4. As a donor, I see one meter per category while I browse, so that I know how much of each Pool I have used.
5. As a donor, I see a warning and a one-click "raise my donation" when my rewards cost more than my pledge amount.
6. As a donor who only wants to donate with a message, I can skip incentives in one click.
7. As a donor, I see on review where money I did not direct goes, and why.
8. As a donor, I can leave `/donate` and come back to my draft, from the navbar or from a new tab.
9. As a donor, I never pay twice for one draft, even after a double click or a lost response.
10. As a donor whose write-in was rejected or whose item was reversed, I can spend the Pool credit on other items of that category in the Event.
11. As a donor, I can see my Wallet credit and my Pool credit separately.
12. As a moderator, I can assign a donation's Unused pool money to the option or goal its comment asks for ("runner's choice").
13. As a moderator or admin, I can order a Channel's Default goal list, and I see a warning when no entry can take money.
14. As an admin, I can cancel an unshipped physical reward and return its money to the donor's payment method before the Event ends.
15. As an admin, I can Wallet-refund or record a chargeback, and I see the effect before I confirm.
16. As an admin, I can end an Event, and undo the end.
17. As an admin, I see "needs attention" items: Payment refunds that are requested or failed, overdue pledges, and shipped claims after a chargeback.
18. As an operator, I can read money totals and incentive totals in metrics without adding one to the other.
19. As a consumer of `TILTIFY` messages (kollekt, esa-layouts-v2), I need no change.
20. As an operator, I can ship the change between Events, check it, and roll back while no new writes exist.

## Implementation Decisions

### §F — Donate flow (#157, #162)

**F1. Amount step.**

- It is the first step on `/donate/<event>/<channel>`. Presets $5 / $10 / $25 / $50 and a free amount input. Minimum $1.
- Two exits: "choose incentives →" and "just donate $X + message". The second goes straight to review.
- The Channel picker stays above the flow, as today.

**F2. Browse step.**

- The existing rewards / polls / goals tabs, under a **sticky pool bar**. The bar shows the pledge amount (click to edit), one compact meter per category (`used / pledge amount`), and "review →".
- Polls and goals keep their progress bars, with the #52 impact preview driven by the pooled allocation. Rewards show their images (`Reward.image_url`).
- **Overage.** When a category is over the pledge amount, its meter turns red. A banner in the bar says, for example, "Your rewards add up to $25, more than your $10 donation", with a one-click "raise my donation to $25". "review →" is disabled until every category fits.
- The Previous/Next loop and the skipped-category reminder are removed.
- `/rewards`, `/polls` and `/goals` redirect to the matching donate tab.

**F3. Review step.**

- Lines are grouped by category. An auto-allocated amount shows as `$5 + $20`, with a locked "auto" tag and its reason ("topped up in proportion", "the Channel's current default goal (now: X)"). Auto rows have no remove control.
- Each category has a one-line explanation, for example: unused reward pool, unused poll money for a moderator, "checked again when your payment completes".
- The totals block shows the pledge amount, the Wallet credit applied, and the new money charged plus shipping.
  - _Derived:_ the prototype's "Wallet credit returned" line is removed. Under the reservation rule a pooled donation creates no Wallet credit when it is fulfilled (#160, ADR-0011 §2).
- Fields: message (≤500 characters, blocked-word filter) and **Display name** (empty = "Anonymous"). Then the pay button.

**F4. Draft pledge** (#162 §1–2).

- One draft per browser, in `localStorage`, shared across tabs through the `storage` event. The last edit wins. It expires 24 h after its last change.
- It stores: the pledge amount, selections, Channel, comment, display name, the last step seen, a stable draft id, and any pending pledge token. A draft exists as soon as the donor confirms an amount.
- Available Wallet credit is recalculated at review. A stored estimate is not secured funding.
- `CartDrawer` and its checkout path are removed. Review inside `/donate` is the only checkout path.
- Outside `/donate`, the navbar "contribute" button becomes **"resume $25 donation"**. It opens `/donate/<event>/<channel>` at the last step seen.
- **Payment state first.** If the draft holds a pending pledge token, resolve that pledge's payment state before any repair. While payment is unresolved, review shows the immutable server-side Pending pledge, not the local draft.
- **Revalidation** of an editable draft runs on load, at "review →", and finally on the server at `createPledge`:
  - An inactive or deleted Channel: keep the amount and the shared items, remove that Channel's items, and show the Channel picker.
  - Remove closed, sold-out, rejected and deleted items. Their money returns to the Pool.
  - Reduce reward quantities to the stock that remains, and use current prices.
  - Show each repair in a notice. Never raise the pledge amount automatically.
  - If the server changes a selection or a price, it returns the corrected review for confirmation.
- A donate link that names another Channel uses the existing Channel-switch confirmation. Switching an unresolved Pending pledge is an edit, and needs a confirmed cancellation first.
- Sign-out deletes the local draft only.
- On load, the client deletes the old cart (`sessionStorage` `donation_cart_v1`) with no notice. `last_donor_email` and `last_donor_display_name` stay and pre-fill the draft (#173 §7).

**F5. Checkout and payment reconciliation** (#162 §3–5).

- **One payable checkout per draft.** Checkout creation is idempotent and serialized on the server by the draft id: at most one OPEN Pending pledge per draft. A retry returns the existing pledge. The pending pledge token is the Stripe idempotency key.
- **Wallet hold.** The wallet-funded part is debited and held when the Pending pledge is created, bound to the signed-in donor. It is used once at fulfillment, or released once on confirmed non-payment.
- **Stripe session.** `expires_at` = the pledge's checkout deadline (2 h, `PLEDGE_TTL_MS`). `/pledge/<token>` is the success return URL, and a separate URL is the cancel return.
- **Webhooks.** Handle `checkout.session.expired` for pledge sessions; today it is ignored (`routes/webhook.ts:57-60`). Fulfil only when `payment_status = paid`. Handle async payment success and failure. A delayed payment stays pending, with its wallet funding held.
- **Cancel.** Expire the Stripe session first. If the result is unclear, retrieve the session and reconcile:
  - confirmed expired or no payment: end the pledge and release the hold;
  - complete, or payment not settled: show "processing";
  - still open, or the state is not known: show an error, and block editing and new checkouts.

  Cancellation never overwrites `FULFILLED`. Show "No payment was taken" only after confirmed non-payment.

- **Resume states.**
  - `FULFILLED`: delete the matching draft and show "Your $25 donation went through" once.
- **Stale responses.** A late response must not overwrite a newer draft or pending token, clear a newer draft, or restore data deleted at sign-out.
  - OPEN: show a read-only review, "continue to payment" (the same session while it can be paid) and "edit" (cancel first).
  - `CANCELLED` or `EXPIRED` with confirmed non-payment: an editable draft at review.
- **Late payment.** A confirmed late payment fulfils its pledge, found by **exact token** only, even when the pledge is `CANCELLED` or `EXPIRED`. Token linkage never falls through to email matching. The normal fulfillment checks apply. Old-shape pledges are an exception (§T2).
- A pledge funded only by Wallet credit keeps today's no-Stripe path.

**F6. API contract** (#173 §8).

- `POST /api/pledge` requires `pledge_amount_cents`. A request without it, or with `top_up_cents`, gets 400: "The donate page was updated. Reload to continue."
- The response returns `pledge_amount_cents` in place of `total_cents` and `top_up_cents`.
- The request carries the pledge plan result the client showed (Wallet credit applied, new money charged, top-up rows).
- Requests are serialized by the draft id. If the draft already has a Pending pledge, `createPledge` resolves it first (§F5) and returns it unchanged on a retry, with no plan comparison. A retry would otherwise see its own hold as spent Wallet credit.
- Only a new attempt runs the plan comparison. If the server's plan differs from the client's, it answers 409 with the server's plan and creates neither a pledge nor a hold, and the client shows the corrected review for confirmation (§F4). Otherwise it stores the plan and the hold in one transaction.

### §P — Pools and accounting (#154, ADR-0011)

**P1. Schema.**

- `PendingPledge`: `pledge_amount_cents`, the held wallet amount, confirmed reward prices, and the draft id. `total_cents` and `top_up_cents` are removed.
- `Donation`: `pledge_amount_cents` (null for a donation without a pledge), a separate shipping record, and the Stripe `payment_intent`.
- `PollVote` and `FundContribution`: `source` (`donor` | `auto` | `moderator`), plus `allocated_by` and `allocated_at` for moderator rows.
- `RewardClaim`: the recorded amount, and the new state `CANCELLING`. An accepted Payment refund reverses the claim. The "cancelled by Payment refund" badge comes from its link to the Payment refund record.
- `Event.ended_at`, plus who ended or undid it, and when.
- `Channel`: the ordered Default goal list.
- The Payment refund record (§R4).
- `BalanceAdjustment.type` gains `WALLET_REFUND` and `FAILED_PAYMENT_REFUND`.

The slice that owns the schema chooses the exact names and shapes.

**P2. Pool rules** (ADR-0011 §1–2).

- Pledge amount = new money + Wallet credit applied. Each Pool equals the pledge amount.
- `createPledge` rejects any category over the pledge amount (400). The client warning is only a convenience.
- Fulfillment runs the spend helpers in **pool mode**: it checks each row against the donation's own Pools and does not subtract from the wallet.
- `Donation.amount_cents` = new money only.
- Shipping is recorded separately and is outside every total.
- Cash floor: Wallet credit applied = min(available, pledge amount − physical prices). A pledge funded only by Wallet credit cannot include a physical reward.
- Stripe minimum: when 0 < new money charged < 50¢, Wallet credit applied becomes pledge amount − 50¢ (ADR-0011 §1.5).
- A Pending pledge keeps the server-validated reward prices the donor confirmed. Live stock and availability are still checked at fulfillment, and an incompatible reward-type change follows the fulfillment-failure path. Physical allocations never exceed the confirmed new money (shipping excluded).
- The max rule and the reservation rule decide Wallet credit. A pooled donation creates no Wallet credit when it is fulfilled.

**P3. `MIN_SPEND_CENTS` ($1)** applies to each donor selection in a new pledge. It does not apply to:

- auto-allocated default-goal money;
- moderator assignments;
- poll or goal Pool credit spends, which can be any positive number of cents.

### §A — Auto-allocation and the Default goal list (#155, #156)

**A1. Proportional top-up.**

- A category's remainder goes to all the donor's selections in that category as one flat set, weighted by their allocations, across several polls and their options.
- Rounding uses largest remainder in integer cents. Ties go to the selection the donor added first.
- Top-ups are added to the existing rows, so every row stays at $1 or more.
- The top-up is computed at review and fixed at `createPledge`.

**A2. Goal money with no selection** is resolved **at fulfillment**, against live eligibility. Eligible means active, not complete, and for this Channel or shared. The order:

1. the first eligible entry of the Channel's Default goal list;
2. the primary Channel's list, with only the entries eligible for the donation's Channel;
3. the eligible goal closest to completion (smallest `target_cents − current_cents`), the Channel's own goals first, then shared goals.

Overshoot is allowed. If no goal is eligible, the money is Unused pool money. A manual or automatic switch for step 3 is deferred to #161 (`wayfinder:deferred`, after this PRD).

**A3. Polls have no default.** Poll money that no open selection takes is Unused pool money.

**A4. Money freed at fulfillment.** A goal that completes or becomes inactive, or a poll that ends, between pledge and payment frees its money. The same rule runs again on that money:

- goals: the donor's other eligible goals (in proportion), then A2;
- polls: the donor's other open options (in proportion), else Unused pool money.

**A5. Write-ins.**

- A `PENDING_APPROVAL` write-in counts as a selection and gets its share.
- On rejection its money becomes poll Pool credit (§C).
- `votePollTx` rejects votes for `REJECTED` options; today it does not check the option status.

**A6. Default goal list.**

- An ordered list per Channel. It can hold the Channel's own goals and shared goals; a goal of another Channel returns 400.
- Moderators and admins set it through the existing channel update (`services/channels.ts`).
- Entries are never removed automatically.
- It ships empty (§T6).

### §C — Pool credit and the credits page (#159, #166)

**C1. Sources of Pool credit.** Admin reverse-spend of a pooled `donor` or `auto` row, a per-item poll option or goal reverse, and a rejected write-in (the whole polls category).

**C2. What the donor can spend it on.**

- Pool credit is shown and spent as **one total per category, combined across the donor's pledges in the Event**.
- It can go to any open item of that category in the same Event, on any Channel or shared.
- Never on a physical reward. Reversing a physical claim gives reward Pool credit, but that credit can only buy non-physical rewards.
- It never becomes Wallet credit.

**C3. Credits page** ("Use your credits", layout Refined B, prototype `VariantB7.tsx`).

- Left column: every open incentive, grouped by category, with short Channel tags (MAIN, SIDE STREAM, SHARED). Each poll option and goal has an always-visible amount field with **set** and **max**. Rewards have whole-unit −/+ controls.
- Sticky side panel: one remaining amount and one meter per category, one **review** button, the confirm list, and one **apply credits**.
- On mobile, a sticky balance bar sits above the list.
- Wallet credit is one muted line in the panel footer. It is spent only through a normal draft pledge.
- The donor can spend part of the credit. The remainder stays credit and is never auto-allocated.
- Credit that is positive but cannot be spent (no eligible item) stays visible, with the reason.
- Choices that are not confirmed live in memory only.
- "Where your credit came from" lists the history.

**C4. Apply.**

- The server validates the whole batch: ownership, eligibility, each category's budget, stock, price, and that the Event has not ended.
- If anything changed, it applies **nothing** and explains the change inline.
- Retries are idempotent.
- Each category draws from its source credits **oldest donation first**. One selection can be split across donations. Each row links to its source donation with `source = donor`.
- Each affected source donation is re-published (§W).

**C5. Event end.** Poll and goal Pool credit becomes Unused pool money, and reward Pool credit expires. This is derived from `ended_at` (§E).

### §U — Unused pool money and moderator assignment (#160)

**U1. Definition.** Per category of a live pooled donation: pledge amount − live rows − outstanding Pool credit − Wallet credit granted from a failed Payment refund. It is computed, not stored. It is poll or goal money only. It is zero for a Wallet-refunded or charged-back donation, and for a donation without a pledge.

**U2. Assign.**

- A moderator assigns **all** of one category's unused money to one target, in one action.
- A valid target is an `ACTIVE` option of an open poll, or an active goal that is not complete, of the donation's Channel or shared. Overshoot is allowed, and amounts under $1 are allowed.
- An unassigned donation (no Channel) is blocked until an admin assigns a Channel.
- A stale amount returns 409.
- The new row has `source = moderator`, plus `allocated_by` (the moderator's session email, else `'moderator'`, like `moderated_by`) and `allocated_at`.
- There is no time limit. The target must still be open.

**U3. Undo.** A moderator can undo an assignment while its target is open. Reversing a moderator row by any path (undo, admin reverse-spend, per-item reverse or delete) returns its money to Unused pool money.

**U4. Moderator list** at `/moderate/unused-pool-money`, between claims and donations in the nav.

- Toggles: "comments only" (on by default) and "show ended Events" (off by default). It follows the global Channel filter.
- Each category with money has an **assign…** button. Its picker lists only eligible targets, each with its impact ("Glitch run $1,000 → $1,005 of $1,500").
- It never returns donor email.

### §R — Reversals (#159, #167, #173 §4)

**R1. Wallet refund** (status `REFUNDED`). Reverse every live row except `FULFILLED` claims, plus Pool credit and Unused pool money. Recompute Wallet credit with the max rule and add the difference (ADR-0011 §5). The money total does not change. Adjustment type `WALLET_REFUND`.

**R2. Chargeback.**

- Reverse the same rows. `FULFILLED` claims are flagged.
- The wallet-funded part goes back to the wallet, less the Wallet credit the donation already granted. A negative result is taken back, capped at the balance.
- The money total goes down by the remaining `amount_cents`.
- A pre-change delayed payment that fails after the deploy (`checkout.session.async_payment_failed`) is recorded as a chargeback under the legacy rule (#173 §2). Slice 5 owns this; slice 3 only receives the webhook type.

**R3. Single-row reversals.**

- Admin reverse-spend and per-item poll option or goal reverse or delete give Pool credit for `donor` and `auto` rows, and Unused pool money for `moderator` rows. They never credit the wallet.
- A write-in rejection gives poll Pool credit. `routes/moderator.ts` (write-in `REJECTED`) stops crediting `balance_remaining`.
- These actions write no `BalanceAdjustment`.

**R4. Payment refund** (#167).

- **Who and when.** Admin only. On a `COMPLETED` donation with a pledge amount and a Stripe payment, for one physical `PENDING` claim, while the donation's Event has not ended. Payment refunds are serialized per donation.
- **Step 1, one transaction.** Validate, create a Payment refund record (`REQUESTED`: item cents, shipping cents, claim, donation, created_by), and lock the claim (`CANCELLING`).
- **Step 2, outside the transaction.** Read `payment_intent` from the Checkout Session and store it (from now on the webhook stores it too). Call `refunds.create` with metadata `{payment_refund_id, donation_id, claim_id}` and the record id as the idempotency key.
- **Accepted** (`succeeded`, `pending`, `requires_action`). A second transaction:
  - reverses the claim and restores the stock;
  - lowers `amount_cents`, `total_donated` and the pledge amount by the claim's recorded amount (capped at the new money that remains);
  - shrinks the Pools (Unused pool money first, then live rows and Pool credit in proportion, largest remainder, ended polls and completed goals included);
  - records the shipping refund and `stripe_refund_id`;
  - publishes (§W).
- **Shipping.** The whole fee comes back only with the donation's last physical claim that is not cancelled. Otherwise it is $0.
- **Rejected at creation** (for example `charge_disputed`). The admin sees it at once. The claim goes back to `PENDING`, and the record is stored as `resolved` ("rejected by Stripe, nothing changed").
- **Unclear outcome** (timeout). The record stays `REQUESTED`. **Retry** lists the PaymentIntent's refunds and matches `payment_refund_id` locally before it calls Stripe again with the same key.
- **Fails later.** An accepted refund that becomes `failed` or `canceled` (`refund.failed` / `refund.updated`) makes the record `failed`, flagged for an admin. Nothing changes automatically. The admin chooses:
  - "Returned outside the app";
  - "Give as Wallet credit" (only on a `COMPLETED` or `REFUNDED` donation): it restores `amount_cents`, `total_donated` and the pledge amount, keeps the Pools shrunk, turns the gap into Wallet credit (`FAILED_PAYMENT_REFUND`), and publishes the totals;
  - on a `CHARGEBACK` donation: "Returned outside the app" or "Settled by the dispute".

  Shipping is resolved separately: "returned outside the app" or "kept by agreement".

- **Later reversals.**
  - A later Wallet refund uses the reduced pledge amount.
  - A later chargeback lowers the total by the remaining `amount_cents` only.
  - No Payment refund after a Wallet refund or a chargeback.
  - While a record is `REQUESTED`, status changes return 409.
- **Stripe webhook.** Subscribe to `refund.*`. The `stripe` SDK 22.5.0 pins API `2026-07-29.dahlia`. Check the endpoint's own API version in the dashboard.

**R5. Charged-back donations.** Reverse-spend is not offered and "mark pending" is blocked on their claims. A shipped claim flagged after a chargeback is cleared with **Acknowledge** (optional note; who and when are recorded). Record chargeback is disabled when the donation's money is $0.

**R6. Legacy rule.** Donations without a pledge and pre-change rows follow ADR-0011 §6: reversals are one to one in Wallet credit, and there is no Payment refund.

- Reverse-spend is blocked on every row type linked to a pre-change `CHARGEBACK` donation. A per-item reverse removes such rows with $0 credit.
- Donations already `REFUNDED` or `CHARGEBACK` before the change are not repaired automatically. The migration report lists them (§T4).

### §E — Event end (#160, #172 §12)

- `POST /api/admin/events/:id/end`, admin only, outside the shared `routes/identityRoutes.ts`.
- It is offered only on an **inactive** Event with no `REQUESTED` Payment refund.
- A server preview shows:
  - poll and goal Pool credit → Unused pool money;
  - reward Pool credit that expires;
  - the Payment refund window closing, with the count of donations that have unshipped physical rewards;
  - open Pending pledges.

  The admin types the Event slug to confirm.

- An ended Event **cannot be reactivated**. Staff see an "ended ‹date›" badge.
- **Undo end** (admin, no time limit) clears `ended_at`. The Event stays inactive, and the Pool credit comes back.
  - It is blocked while a moderator assignment made after the end uses that money. A moderator undoes the assignment, or an admin reverses it.
  - It reopens the Payment refund window.
  - The preview shows the Pool credit that comes back.
- The changes to Pool credit are **derived from `ended_at`**, not stored as transfers (ADR-0011 §4.3).

### §W — Webhook messages (#153, #159, #167; ADR-0009 amended)

- **Tiltify donation message.** Re-published under the same id, **when its content changes**, after the actions below. An identical re-publish replays the overlay alert, so it is not sent (ADR-0011 §7.1):
  - every reversal (Wallet refund, chargeback, reverse-spend, per-item reverse, write-in rejection);
  - every Pool credit spend;
  - every moderator assignment or undo;
  - every Payment refund.

  Reversed rows are left out and new rows are included. `target_contributions[].amount` holds the goal allocation. `amount` stays the donation's money. `source` is not sent.

- **Tiltify totals** (Channel and Event) are published whenever a donation's counted amount changes: a chargeback, an accepted Payment refund, a failed Payment refund given as Wallet credit, and the transition corrections (§T5). One publish sends them once per affected Channel and once per affected Event. The transition corrections are the only forced publish: they have no "before" state to compare.
- **Native `donation.created`** exposes each allocation's `source` (#156).
- **New native `donation.updated`.** The donation's full current state: status, money, pledge amount, and live allocations with `source`. It is sent after any status or allocation change, and consumers replace their copy by donation id. Destinations opt in through `event_types`; the migration changes no Destination.
- Donor email and staff identity (`allocated_by`) are never sent.
- A pooled contract test is added to `server/test/services/webhooks/tiltify.test.ts` (#153).

### §M — Metrics and stats (#171)

**M1. Labels.**

- Allocated cents use the **incentive's** Event and Channel. A shared incentive gets `event=""`, `channel=""`.
- Unused pool money and Pool credit use the **donation's** Event and Channel.

**M2. New gauges.**

- `dono_incentive_allocated_cents_by_channel{event, channel, category="reward|poll|goal", source="donor|auto|moderator"}`: live rows only. Claims count at their recorded amount, and a `CANCELLING` claim counts until Stripe accepts the refund.
- `dono_pool_unused_cents_by_channel{event, channel, category="poll|goal"}`.
- `dono_pool_credit_cents_by_channel{event, channel, category="reward|poll|goal"}`.
- `dono_wallet_credit_cents{state="available|held"}`.
- `dono_pledges_overdue`: OPEN pledges past their deadline whose session is not completed.
- `dono_payment_refunds{status="requested|pending|requires_action|succeeded|failed|resolved"}`: counts only. `resolved` includes Payment refunds that Stripe rejected at creation.
- `dono_payment_refunds_oldest_requested_age_seconds`.

**M3. Changed gauges.**

- `dono_reward_claims_total` and `_by_channel` count live claims only.
- `dono_balance_adjustments_total{type}` adds `WALLET_REFUND` and `FAILED_PAYMENT_REFUND`. `REFUND` is still written, but only for legacy item reversals.
- `dono_donated_cents_*` and `dono_pledges_open` keep their meaning.

**M4. `GET /api/admin/stats`.**

- Overall: `pledged_cents`, `wallet_credit_cents: {available, held}` (replaces `unallocated_credits_cents`), live `claims`, `pledges: {open, overdue}`, `payment_refunds: {requested, failed}`.
- Per Channel: `pledged_cents`, `allocated_cents: {reward, poll, goal}`, `unused_pool_cents: {poll, goal}`, `pool_credit_cents: {reward, poll, goal}`.
- A `shared` entry holds the allocated cents of shared incentives.
- `pledged_cents` covers pooled `COMPLETED` and `REFUNDED` donations at their current pledge amount.
- The stats use the same aggregation code as the gauges.

**M5. `GET /api/moderator/stats`.** Adds `unused_pool: {with_comment: {donations, cents: {poll, goal}}, all: {…}}` for Events that have not ended. No donor email.

### §S — Staff pages (#172)

**S1. Labelling rule.**

- Only `amount_cents` and raised totals are **money**: the word "money" and the yellow money style.
- Every other amount has its own name, in a neutral style.
- A panel that shows both carries the note: _"Incentive amounts are not money: one dollar can count once in rewards, once in polls and once in goals."_
- No sum across categories, and no sum that mixes money with other amounts.

**S2. Admin donations.**

- **List:** a money column, a pledge amount column ("—" without a pledge), flags, and a **needs attention** chip. The status dropdown becomes a badge.
- **Detail page `/admin/donations/:id`** (refined C: header actions and tabs).
  - Header: money, pledge amount, Wallet credit applied.
  - Pool tabs with live rows tagged by source. Pool credit and Unused pool money, with info tooltips.
  - The donation's Payment refunds, with the ended targets each one lowered. Flagged shipped claims.
- **Status actions.** **Wallet refund** and **Record chargeback**, each with a server-computed preview. Both are disabled, with the reason, while a Payment refund is `REQUESTED` or when the status is terminal. Manual `PENDING` ↔ `COMPLETED` changes are removed.
- **Cancel with Payment refund** on each eligible claim (Rewards tab). An ineligible claim shows its reason. A server preview shows the item and shipping amounts, money and pledge amount before → after, the Pool shrink per category, and the ended polls or completed goals whose totals drop.
- A **payment refunds** tab lists records across donations, filtered to open records by default, with the row actions of §R4.

**S3. Admin pledges.**

- OPEN by default, with chips for "overdue" and every status, and pagination.
- Columns: the held Wallet credit, the new money due plus shipping, the Stripe session state and `payment_status`, the deadline, and a donation link.
- Confirmed and current prices.
- **Check Stripe** runs the §F5 reconciliation. There is no manual release and no automatic sweep.
- The dead Tiltify relay fields are removed. A note says Draft pledges stay in the browser.
- A late old-shape payment shows "paid after transition: not fulfilled".

**S4. Admin donor page.**

- Header: total donated, Wallet credit available and held, role.
- A read-only Pool credit panel per Event and category.
- Spend rows show the recorded amount, the source and the source donation.
- **Reverse** confirms where the money goes ("+$12.00 poll Pool credit", or "back to Unused pool money of donation …").
- "Adjust balance" becomes **adjust Wallet credit**.
- `REFUND` is labelled "REFUND (old)".
- Sweep credits zeroes available Wallet credit only.

**S5. Incentive pages (admin and moderator).**

- "Refund votes" and "refund contributions" become **reverse votes** and **reverse contributions**, with a preview by destination.
- Hard deletes return 409 when the item has any allocation rows, live or reversed: _"This has allocation history. Deactivate it instead."_ This also fixes the delete crash in #175.
- Totals are labelled **allocated**, with a muted source split when some rows are `auto` or `moderator`.
- Rewards show "12 claimed · $300 allocated". Claim lists show the recorded amount and "(price now $30)".

**S6. Claims.**

- **Admin claims tab:** a donation link, the recorded amount, and badges. The toggle allows only `PENDING ↔ FULFILLED`, enforced in the UI and the API. It is blocked on charged-back donations and while a Payment refund is `REQUESTED`.
- `GET /api/admin/claims` still returns every claim.
- **Moderator claims:** `donor_name` comes from the claim's own donation, or from the donor's newest donation when the claim has none. Live claims only, with the recorded amount.

**S7. Dashboards.**

- **Admin:** Money cards; Needs attention cards (Payment refunds requested, Payment refunds failed, pledges overdue); Credits cards. Two per-Channel tables: **Money by Channel** and **Incentives by Channel (not money)**. The "unallocated credits" card is removed.
- **Moderator:** an **unused pool money** card.

**S8. Moderator donations.**

- Money and pledge amount.
- Live rows by category with source tags (they replace the `PendingPledge.items` chips).
- `allocated_by` and `allocated_at`, and **undo**, on moderator rows.
- Unused pool money chips.
- A status badge when the donation is not `COMPLETED`.
- "unassigned" in place of "shared".
- The "additional contribution" chip is removed. Pool credit is not shown.

**S9. Default goal list editor** in the shared channel edit form.

- Ordered entries with ↑ / ↓ buttons, state and progress. The first eligible entry is marked "receives goal-Pool money now".
- **Add goal…** offers only the Channel's own goals and shared goals.
- A warning names the live fallback when no entry is eligible. Only the automatic-mode text is in scope (#161 owns the manual text).
- The channel card shows a "no eligible default goal" badge. Goal cards show tags such as "MAIN default #2".

**S10. Donor email.**

- Shared services never return donor email. Only `routes/admin.ts` adds it.
- `moderator-donor-email.test.ts` is extended to `routes/identityRoutes.ts` and every `services/*` module those routes import.
- Each new moderator endpoint gets a behavioural test with a marker email.
- **Acceptance criterion.**

**S11. Shared text.** `server/openapi.yaml`, `client/src/types.ts` and `client/src/pages/shared/StaffHelp.tsx` follow the new vocabulary. The help text drops "platform does not issue card refunds".

### §T — Transition (#173)

**T1. Window.**

- Ship only while no Event is active. This is a runbook precondition, not a code check.
- Every migration works on a non-empty database.
- In an emergency, pre-change donations are donations without a pledge, beside pooled ones in the same Event.

**T2. Old-shape Pending pledges.**

- A drain script expires the Stripe session of every OPEN pledge before the deploy, and reports completed sessions with `payment_status = unpaid`.
- The migration marks every OPEN old-shape pledge `EXPIRED`.
- `/pledge/<token>` still renders an old-shape pledge read-only: status, items, and pledge amount "—".
- A payment that still arrives:
  - matches by exact token only;
  - becomes a donation without a pledge, with the pledge's Channel, comment and display name, linked through `fulfilled_by_donation_id`;
  - its new money goes to Wallet credit, and no rows are created;
  - its shipping is recorded separately.

**T3. Backfills.**

- `source = donor` on every existing `PollVote` and `FundContribution`.
- Every existing `RewardClaim` gets the reward's `cost_cents` at migration as its recorded amount.
- Pre-change donations get no pledge amount.

**T4. Migration report.** Donations already `REFUNDED` or `CHARGEBACK`, with their live linked rows and the adjustment already applied. An admin can use it for `MANUAL` corrections (#163).

**T5. Money corrections.**

- The migration sets `amount_cents = 0` on every `wallet-<uuid>` donation (#158).
- A one-off, idempotent **shipping script** reads `total_details.amount_shipping` for every Stripe-backed donation. It records the shipping separately and lowers `amount_cents` and `total_donated`. Donations it cannot resolve are listed in its report.
- After the overlay-binding check (a re-publish replays the alert), the corrections are published: the Tiltify totals once per affected Channel and Event, each corrected donation re-published, and `donation.updated`.

**T6. Initial state.**

- `balance_remaining` becomes available Wallet credit. Held credit is $0.
- `ended_at` is null on every Event.
- Default goal lists are empty.
- `donation.updated` is opt-in.

**T7. Sibling callers** (confirmed with `rg -uu`, see `docs/api-consumers.md`). Updated in the same rollout:

- `scripts/e2e-incentives.ts:95-108` asserts `total_cents`;
- `staging/incentive-test.py` imports `services/pledge.ts` `createPledge` directly and posts `pledge.total_cents`.

Other changed endpoints stay additive.

**T8. Runbook** (in `docs/deployment.md`, owner: transition slice):

1. Subscribe the Stripe endpoint to: async payment success and failure, `checkout.session.expired`, and `refund.*`.
2. Confirm that no Event is active.
3. **Write barrier:** deactivate every Channel (`createPledge` then returns 404).
4. Run the drain script.
5. Stop the backend. Take an `sqlite3 .backup` and note its timestamp.
6. Deploy one release. `prisma migrate deploy` runs the schema migration, then the backfills. Start the backend.
7. Run the non-destructive checks:
   - `/api/health`;
   - the migration report;
   - counted money total = old counted total − counted `wallet-` amounts (− shipping moved, after the script);
   - `total_donated`.

   Never run `scripts/smoke-test.sh` against a deployment.

8. Overlay-binding check, then the shipping script and the publishing of §T5.
9. Opt NATIVE Destinations in to `donation.updated` where the consumer handles it.
10. At the next Event's go-live: fill the Default goal lists, then reactivate the Channels and the Event.

**Rollback:** restore the backup and the previous image **only if nothing was written after the backup timestamp**. The runbook gives the count query. Otherwise, fix forward.

### §O — Operator runbook: refunds and chargebacks (#167 §8)

A section in `docs/deployment.md` (or a linked doc) covers:

- Wallet refund versus Payment refund;
- the money total is too low while a refund is `requires_action`;
- how to resolve failed and cancelled Payment refunds;
- a dispute opened after a Payment refund, including a dispute for the full charge;
- the processing fee Stripe keeps on a refund, and the dispute fee.

## Testing Decisions

- **Pools.**
  - Pledge plan table tests in `packages/shared` (it gets a vitest runner and real `test` / `test:ci` scripts), from the worked examples of #154 and #156: rounding and ties, the cash floor, the Stripe minimum.
  - `createPledge` stores the plan's result, and answers 409 with the server's plan when the client's differs. A retry of a draft that has a Pending pledge returns that pledge unchanged, with no 409, its hold included.
  - The Stripe minimum: D = $10 with $9.75 of Wallet credit applies $9.50 and charges 50¢.
  - `createPledge` rejects a category over the pledge amount.
  - The cash floor and the Wallet credit applied: W = min(B, D − P).
  - A pledge funded only by Wallet credit cannot include a physical reward.
  - `amount_cents` = new money, and shipping is excluded.
  - The #158 double count is gone.
- **Max rule and reservation.** Use the worked examples of #154, #159, #160 and #167 as table tests. A pooled fulfillment grants $0 Wallet credit. Pool credit and Unused pool money count as used.
- **Auto-allocation.**
  - Largest-remainder rounding and its tie rule.
  - One flat set across polls.
  - The default goal chain (own list, primary list, closest to completion), with overshoot.
  - Money freed at fulfillment.
  - A pending write-in gets its share. `votePollTx` rejects a `REJECTED` option.
- **Reversals.** One test per row of the ADR-0011 §5 table, and one per legacy rule (ADR-0011 §6). Moderator rows return to Unused pool money. A charged-back donation blocks reverse and "mark pending". Test through the Reversal module's interface (slice 0) against the SQLite test database, not with mocked Prisma.
- **Payment refund.** Mock Stripe for accepted, rejected at creation, timeout then retry with the metadata match, failed later with each resolution, and serialized requests per donation. Also: shipping only with the last physical claim, the shrink with ended targets, 409 on status changes while `REQUESTED`, and the window after Event end and Undo end.
- **Checkout.**
  - Idempotent creation per draft id.
  - The wallet hold is used once and released once.
  - `checkout.session.expired`, async payment success and failure, `payment_status` checks.
  - A late payment matches by exact token, with no email fallback.
  - An old-shape late payment becomes a donation without a pledge.
- **Event end.** The derived conversion. Undo end restores it. Undo end is blocked by a later moderator assignment. No reactivation.
- **Messages.** Test the donation publishing module (slice 0b) as a table: one before/after change per row, asserting the queued deliveries.
  - The pooled Tiltify contract test (#153).
  - `donation.updated` shape, and its opt-in through `event_types`.
  - Re-publish without reversed rows.
  - Totals published on each counted-amount change.
- **Metrics and stats.** The label rules of §M1. Live rows only. The gauges and `/admin/stats` agree.
- **Donor email.** §S10 tests (acceptance criterion).
- **Migration.** Run the backfills on a non-empty fixture database, then check the money-total check of §T8 step 7.
- **Client.** Pool bar meters, the overage banner and "raise to $X", the review auto rows, draft resume across tabs, revalidation notices, and the credits-page apply.
- **Routes.** `server/test/openapi-coverage.test.ts` must pass for every new route.
- Run `npm run typecheck` and `npm test` from the repo root.
- Run the sibling E2E (`scripts/test-incentives.sh`) after §T7.

## Work Breakdown

Proposed slices. They are not filed yet. Slices that change `schema.prisma` land **one at a time, in order**, and only one migration is open at any time (the PRD-0002 conflict rule). The change has no feature flag, so every slice ships in **one release**, between Events (§T). The prefactor slices 0, 0b, 0c and 0d are the exception: they change no schema, so each can ship in an earlier release, with only the behaviour changes listed in its notes.

| #   | Slice                                                                                                                                                                               | Sections                          | Depends on     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| 0   | Reversal module (prefactor): move every reversal into one module under the current rule, checks inside the transaction, real-database tests                                         | §R (prefactor)                    | —              |
| 0b  | Donation publishing module (prefactor): one module decides every donation webhook message and the totals from a before/after comparison; fixes #179                                 | §W (prefactor)                    | —              |
| 0c  | Donation intake module (prefactor): Stripe Checkout, wallet-only pledges and admin add go through one intake; magic link after commit, no other behaviour change                    | §F5, §P2 (prefactor)              | 0b             |
| 0d  | Incentive lifecycle module (prefactor): admin and moderator incentive create, update and delete through one module; moderator messages; delete policy (#175)                        | §S5 (prefactor)                   | 0              |
| 1   | Schema, backfills and the migration report                                                                                                                                          | §P1, §T3–T4, §T5 (`wallet-` → $0) | —              |
| 2   | Pooled pledge core: `POST /pledge` contract, pledge plan, Pool validation, cash floor, price lock, auto-allocation, pool-mode fulfillment, Default goal list (server)               | §F6, §P2–P3, §A                   | 0c, 1          |
| 3   | Checkout and payment reconciliation: idempotency, wallet hold, Stripe expiry, new webhook types, late payments, old-shape payments                                                  | §F5, §T2                          | 0c, 2          |
| 4   | Donate client: amount step, pool bar and review on the pledge plan, draft and resume, drawer removal, redirects                                                                     | §F1–F4                            | 2, 3           |
| 5   | Reversals and messages: Wallet refund, chargeback (incl. §R2 legacy), reverse-spend, per-item reverse, write-in rejection, legacy rule, `donation.updated`, re-publish, totals rule | §R1–R3, §R5–R6, §W                | 0, 0b, 2, 3    |
| 6   | Pool credit: credits page and atomic apply                                                                                                                                          | §C                                | 5              |
| 7   | Unused pool money and Event end: moderator list, assign, undo, End Event, Undo end                                                                                                  | §U, §E                            | 0d, 5          |
| 8   | Payment refund: Stripe refunds, records, `refund.*` webhook, failure resolution                                                                                                     | §R4                               | 5, 7           |
| 9   | Metrics and stats                                                                                                                                                                   | §M                                | 5, 7, 8        |
| 10  | Staff pages                                                                                                                                                                         | §S                                | 0d, 3, 7, 8, 9 |
| 11  | Transition tooling: drain script, shipping script, sibling callers, runbooks                                                                                                        | §T2, §T5, §T7–T8, §O              | 3, 8           |
| 12  | Documentation consistency review                                                                                                                                                    | Documentation Requirements        | all            |

**Slice 0 (prefactor).** Today the reversal rule is written in seven places, and the copies disagree. Slice 5 would otherwise add the ADR-0011 §5 table and the legacy rule to every copy.

- Paths to move behind one module:
  - admin reverse-spend, one branch each for claims, votes and contributions (`routes/admin.ts`);
  - the admin donation status change to `REFUNDED` or `CHARGEBACK` (`routes/admin.ts`);
  - write-in rejection (`routes/moderator.ts`);
  - the per-item poll option and goal refunds (`services/refund.ts`);
  - the Wallet credit ledger writes of `adjust-balance` and `sweep-credits` (`routes/admin.ts`), as an internal part of the module.
- Route handlers only parse input, name the row or donation and the actor, and map errors.
- The module reads and checks state inside the transaction. Reverse-spend and write-in rejection check it outside the transaction today, so a double submit can credit twice. Write-in rejection re-checks the entry, the option and the funding vote inside its transaction.
- Each path otherwise keeps its current accounting, which is **not** the ADR-0011 §6 legacy rule: the status change to `REFUNDED` or `CHARGEBACK` still takes `min(amount, balance)` from the wallet and reverses no rows (#163), and a claim reversal still uses the live reward price. Slice 5 brings in both the §6 legacy rule and the pooled rule. The slice has no schema change, so it can merge before slice 1 and ship in an earlier release.
- Tests at the module interface on the SQLite test database replace the mocked-Prisma reverse-spend and refund route tests. They also cover the vote and contribution branches, which have no test today.
- Slice 5 then adds the pooled rule, Pool credit, Unused pool money and re-publishing (§W) inside this module.

**Slice 0b (prefactor).** Today five callers each decide which webhook messages a donation change produces (`services/donation.ts`, `services/pledge.ts` wallet-only checkout, `services/routing.ts`, the moderator moderate and hide route, the admin status route). Native messages are built from a donation object that the caller assembles; the Tiltify donation message reads its own. Slice 5 would otherwise add about 8 re-publish triggers and `donation.updated` to every caller.

- One module covers the donation webhook messages (native `donation.*`, the Tiltify donation message) and the Channel and Event totals. `incentive.*` messages stay out.
- A caller takes a snapshot of the donation through the module before its change (`null` for a donation that did not exist yet), and hands it back after the change. `publishRoutedDonation` goes. The module reads the donation and its live allocations again inside the transaction and compares:
  - nothing is published while the donation is unassigned (no Channel and no Event, §E6 of PRD-0002);
  - not routed (or new) → routed: `donation.created`, the Tiltify donation message and totals;
  - `hidden_from_overlay` changed: `donation.hidden` or `donation.unhidden`;
  - `moderated` changed (value differs from before): `donation.moderated`;
  - the Tiltify donation payload built after the change differs from the one built before: the Tiltify donation message;
  - counted amount changed: totals.
- Callers no longer build `DonationForPayload`; the re-read in `processDonation` goes.
- `withWebhooks` passes the donation publisher in place of today's `tiltify` argument. The Tiltify donation and totals builders become internal to the module. `emit` stays for `incentive.*` messages.
- A snapshot takes one or more donation ids. One publish sends totals once per affected Channel and once per affected Event, after every donation's messages.
- A forced publish with no snapshot exists only for the §T5 transition corrections (slice 11).
- Write-in approval re-checks the entry, the option and the funding vote inside its transaction. Today it reads them before the transaction, so an approval can commit after a rejection and count a reversed vote.
- Order per donation: `donation.created`, `donation.moderated`, `donation.hidden` or `donation.unhidden`, then the Tiltify donation message (ADR-0007 delivers each Destination's queue in order).
- With no active TILTIFY Destination, the module neither builds nor compares Tiltify payloads, decided once per transaction as today.
- Intentional wire changes, each with a contract test; nothing else changes:
  - approving a write-in re-publishes its donation (#179);
  - no `donation.moderated` when the value does not change, or for an unassigned donation (today the moderator route sends it whenever the request has `moderated`);
  - no totals when the counted amount does not change (today the admin status route sends them when the status enters or leaves the counted set, even for a $0 donation).
- It does not depend on slice 0 and can run in parallel with it. Slice 5 then adds `donation.updated` (sent when its payload changes, by the same comparison), `source`, the reversal triggers and the totals-on-counted-amount rule inside this module, and slice 0's reversals call it.
- Tests: table tests at the module interface on the SQLite test database, one row per before → after change, asserting the queued deliveries per Destination format. Concurrent approval and rejection of one write-in, and a double approval, count its vote at most once. The wire contract tests in `server/test/services/webhooks/tiltify.test.ts` stay as they are.

**Slice 0c (prefactor).** Today two copies record a donation: `processDonation` (`services/donation.ts`, called by the Stripe webhook and by admin "add donation") and the wallet-only branch of `createCheckoutForPledge` (`services/pledge.ts`). They differ in the donor update, `amount_cents`, the pledge lookup and when the magic link is sent. ADR-0011 §1.3 and §1.8 would otherwise change both.

- One intake module covers three sources: Stripe Checkout, a wallet-only pledge and admin "add donation" (external donations and the simulator). Auction settlement stays out.
- Callers pass only what their source knows: Stripe the session id, amount, shipping, email, name and pledge token; wallet-only the pledge and the signed-in donor; admin add the amount, email, display name, comment, Channel or Event, date, `external_id` and an optional pledge token (`staging/incentive-test.py`, listed in `docs/api-consumers.md`, sends the token and `external_id`). The intake decides the donor, the money split, `total_donated` and Wallet credit. No caller computes `amount_cents` or the pledge amount.
- `createCheckoutForPledge` keeps choosing the path (wallet-only or Stripe). The intake receives a finished payment and does not import `stripe.ts`.
- `resolvePledge` and `fulfillPledge` become internal to the intake. `services/pledge.ts` keeps `createPledge` and `createCheckoutForPledge`.
- The intake opens its own transaction through `withWebhooks`, publishes through the slice 0b module, and sends the magic link only after commit. This is an intentional change: `processDonation` sends it from inside the transaction today.
- The admin add response keeps its shape: 409 on a duplicate `external_id`, and the pledge result.
- No behaviour change otherwise: `amount_cents` still includes shipping, the wallet-only double count (#158) stays, and the email fallback on pledge lookup stays. Slices 1, 2 (§P2, §T5) and 3 (§F5) change these rules inside the intake.
- Tests: one table per source at the intake interface on the SQLite test database (donor, `amount_cents`, `total_donated`, Wallet credit, pledge status, queued deliveries). They replace the mocked-Prisma `server/test/services/donation.test.ts` and the `resolvePledge` tests in `server/test/services/pledge.test.ts`. `server/test/routes/webhook.test.ts` keeps only signature handling and the mapping from a Stripe session to the intake input.
- Docs: update `docs/architecture.md` where it names `processDonation`, `resolvePledge` and `fulfillPledge`.

**Slice 0d (prefactor).** Admin and moderator routes change the same incentives differently. Admin sends `incentive.*` messages but reads the prior row outside the transaction; moderator sends none. Moderator deletes of a goal or poll option, and both roles' poll delete, are hard deletes that crash the process when the item has allocations (#175).

- One incentive lifecycle module owns create, update and delete of Reward, Poll, PollOption and Goal: the prior row read inside the transaction, the enable/disable/value-changed diff, and the `incentive.*` messages built from rows. Both roles get the same behaviour; routers keep the role check and what each role may do.
- Out: write-in approve and reject (slices 0 and 0b), the Default goal list (`services/channels.ts`), Event end.
- Delete policy, two operations:
  - **remove**: hard delete only with no allocation history (live or reversed rows), else 409 "This has allocation history. Deactivate it instead." Every kind, both roles.
  - **reverse and deactivate**: reverse the rows through the Reversal module (slice 0), then deactivate. Admin only. Admin `DELETE /goals/:id` and `DELETE /polls/options/:id` keep their wire behaviour by calling it. §S5 later turns it into "reverse votes / reverse contributions" with a preview.
- #175 fixes the process crash on its own (global async error handling); slice 0d owns the 409 delete rule.
- No new message types: adding or renaming a poll option still sends nothing.
- No new input validation; the field mapping stays as today (see Open Questions).
- A replaced reward image is deleted only after the update commits.
- Tests: one suite at the module interface on the SQLite test database (queued `incentive.*` messages, the 409 remove rule, reverse and deactivate). Admin and moderator route tests keep only role access and the mapping from request to module input.

**Pledge plan (slices 2 and 4).** One pure module in `packages/shared` computes everything about a pledge that needs no database. Slice 2 creates it; slice 4 builds the pool bar, the overage banner and the review step on it. There is no prefactor slice: the code it replaces (`top_up_cents`, the cart wallet estimate in `CartDrawer`, the wallet discount in `createCheckoutForPledge`) is deleted by slices 2 to 4.

- It computes: each Pool's usage and overage; the A1 proportional top-up (largest remainder in integer cents, ties to the selection added first, every row ≥ $1); `MIN_SPEND_CENTS` on donor selections (§P3); the cash floor and Wallet credit applied, W = min(available, D − physical prices); the new money charged, D − W, with the 50¢ Stripe minimum (when 0 < D − W < 50¢, W becomes D − 50¢, §P2); and whether shipping is required.
- Inputs: the pledge amount, the selections (category, target, amount, order added, physical or not), their prices, and the available Wallet credit (`null` when signed out).
- What needs live data stays out: stock, closed polls, the Channel match, the A2 Default goal chain and the A4 money freed at fulfillment.
- `createPledge` runs the same plan with the prices it validated and the donor's live Wallet credit, and stores its result on the Pending pledge: the top-up rows, the held W (slice 3) and the confirmed prices. The client's result is for display only.
- When the client's result differs from the server's on a new attempt, `POST /pledge` answers 409 with the server's plan. A retry of a draft that already has a Pending pledge returns that pledge without a comparison (§F6).
- Tests: table tests next to the module. Slice 2 adds a vitest runner to `packages/shared`; the root `npm test` and `npm run test:ci` already run every workspace. Client tests assert rendering only.

External follow-ups (optional, no code needed for this release):

- kollekt: a label or operator briefing. A target allocation line can equal the donation amount while the same donation also shows a poll vote and a reward (#153).
- esa-observability: alerts on `dono_payment_refunds_oldest_requested_age_seconds` (for example > 5 min) and `dono_pledges_overdue`.

Deferred: #161 (manual or automatic goal fallback) starts after this PRD ships.

## Documentation Requirements

| Audience        | Document                                                                         | Change                                                                                                                                                                                                                         | Owner slice |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Agents          | `CONTEXT.md`                                                                     | Terms are in place. Check them against the shipped behaviour.                                                                                                                                                                  | 12          |
| Agents          | `docs/architecture.md` § Pledge / Cart Flow, § Balance mutations, § Webhook flow | Rewrite for pledge amount, Pools, pool mode, wallet hold and the new webhook types. Slice 0c first replaces `processDonation`, `resolvePledge` and `fulfillPledge` with the intake module                                      | 0c, 2, 3    |
| Agents + humans | `docs/adr/0009-tiltify-compatible-messages.md`                                   | "Amended in part by ADR-0011" (already added). The "Refunds" bullet stays as history.                                                                                                                                          | —           |
| Agents          | `server/lib/donationTotals.ts:8` (comment)                                       | ESA refunds to the payment method only through a Payment refund, which lowers `amount_cents` in place                                                                                                                          | 8           |
| API consumers   | `docs/outbound-events.md` (formats table, line 33 bullet)                        | Re-publish triggers, totals on every counted-amount change, Payment refund, `donation.updated` (opt-in)                                                                                                                        | 5, 8        |
| Operators       | `docs/webhooks-and-metrics.md`                                                   | New gauges and label rules. Incentive, Pool credit and Unused pool cents are **not money**. Deduplicate replicas with `max without (instance)` first. `REFUND` is the legacy item-reversal value. The count gauges count rows. | 9           |
| Operators       | `docs/deployment.md`                                                             | Transition runbook (§T8) and refunds runbook (§O)                                                                                                                                                                              | 11          |
| Humans          | `docs/api-consumers.md`                                                          | `POST /pledge` contract and its sibling callers                                                                                                                                                                                | 2, 11       |
| Humans          | `docs/simulating-donations.md`, `docs/local-development.md`                      | Seed and simulator use pledge amounts                                                                                                                                                                                          | 2           |
| Staff           | `client/src/pages/shared/StaffHelp.tsx`                                          | Wallet refund, Payment refund, Pool credit, Unused pool money, reverse, Default goal list, End Event                                                                                                                           | 10          |
| API             | `server/openapi.yaml`, `client/src/types.ts`                                     | Every new or changed route and shape                                                                                                                                                                                           | each        |
| Agents + humans | ADR-0010 or `docs/outbound-events.md` § "Totals match"                           | Incentive totals are not money totals                                                                                                                                                                                          | 5           |

## ADR Conflicts

- **ADR-0009 §Refunds.** It says ESA never refunds to the payment method, and totals are published only when the status moves into or out of the counted set. ADR-0011 adds the Payment refund and publishes totals whenever a donation's counted amount changes. ADR-0009 now carries an "Amended in part by ADR-0011" note.
- **Current code that contradicts this PRD.** These are fixed by the slices, not by docs:
  - `server/routes/webhook.ts:67-68` puts shipping into `amount_cents` (§P2, §T5);
  - `server/routes/admin.ts:724` reverses at the live price (§P2, §T3);
  - the `REFUNDED` status change takes credit (#163, §R1).

## Open Questions

None block slicing. Four are left to the slice that owns them:

- Incentive input validation: slice 10 (§S5). Neither role's routes check cents, title or that the Channel exists; `is_complete` can be set by hand on a goal (see the goal-completion question below); `channel_id` can change on an incentive that has allocation history.
- The goal-completion rule after a reverse-spend, a per-item goal reverse and a Wallet refund: slice 0 records the current per-path behaviour, slice 5 decides. Reverse-spend keeps a goal complete unless its total drops to $0; the per-item goal refund recomputes it against the target. Already decided: a chargeback keeps completed goals complete (ADR-0011 §5), and the Payment refund shrink includes completed goals and ended polls (#167 §2).
- The exact schema names (§P1): slice 1.
- Whether `docs/deployment.md` or a separate runbook file holds §T8 and §O: slice 11.

## Out of Scope

- **Auctions.** They use non-binding bids and their own Stripe Checkout.
- **Schedule-linked incentives** (incentives that open and close with the run schedule). A separate effort. It could later set the order of the Default goal list.
- **Manual goal fallback** (#161), deferred.
- **Repairing donations that were refunded or charged back before the change.** The migration report lists them for manual adjustment.
- **The auction eligibility bug** (#176) and **the crash on async route errors** (#175, apart from the delete routes that §S5 fixes). They are tracked separately.

## Further Notes

- **Prototypes** (fixture-only, not for merge):
  - donate flow: `prototype/amount-first-donate` (`VariantA.tsx`);
  - credits page: `prototype/wallet-pool-credit` at `dc07957` (`VariantB7.tsx`);
  - staff views: `prototype/staff-pool-views` at `00bc77a`.
- **Research:**
  - `research/tiltify-incentive-precedent` (`docs/research/tiltify-incentive-precedent.md`, #152);
  - `research/pooled-totals-consumer-impact` (`docs/research/pooled-totals-consumer-impact.md`, #153).
- **Bugs fixed on the way:** #158 (wallet-only donations count twice) and #163 (`REFUNDED` takes credit).
- The `esa-observability` files cited in #171 were uncommitted in that repo on 2026-10-10. Check the claim about outside consumers again before slice 9.
