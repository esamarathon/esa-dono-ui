# ADR-0011: Pooled Allocation Accounting

**Date:** 2026-10-11

**Status:** Accepted

**Related:** [PRD-0003](../prd/0003-amount-first-donation-flow.md), wayfinder map esamarathon/esa-dono-ui#151, [ADR-0009](0009-tiltify-compatible-messages.md) (amended in part: refunds), [ADR-0010](0010-tiltify-compatible-rest-api.md) (incentive totals), [ADR-0007](0007-webhook-delivery-semantics.md) (transactions and external calls), `CONTEXT.md` § Money and incentives

## Context

Before this change, one dollar could be spent once. A donation credits `Donor.balance_remaining`, and each reward claim, poll vote and goal contribution subtracts its amount from it (`server/services/spend.ts`). A pledge is a list of items plus an optional additional contribution (`top_up_cents`). Its Stripe charge is the sum of the items, less a wallet discount, plus the additional contribution.

The amount-first donation flow (PRD-0003) changes the donor's promise. The donor first states a **Pledge amount** D. Each incentive category (rewards, polls, goals) gets a **Pool** equal to D. So $10 can claim $10 of rewards **and** cast $10 of poll votes **and** give $10 to goals. Each incentive's progress goes up by its allocation. The **Money total** goes up only by the money paid.

Tiltify is a precedent for one selection per category. One Tiltify donation can claim rewards, vote for one poll option and fund one target. It very probably counts in full toward each, but this is an inference that was not checked with live numbers (map ticket #152). No consumer of our messages or REST API reconciles incentive amounts with money (#153). This makes the model safe on the wire. The difficulty is inside our own books:

- a wallet that can hold money a donor gave but did not use;
- reversals (refunds, chargebacks, admin reverse-spend, rejected write-ins), where adding up reversed item amounts would create credit that never existed: a $10 donation can back $30 of incentive rows;
- physical rewards, whose shipping must not be charged twice, and whose cancellation sends money back to the payment method;
- donations made before the change, whose dollars were spent once.

These rules are hard to reverse once money is recorded under them, and some of them are surprising. They are recorded here. PRD-0003 holds the product detail and cites the map tickets.

## Decision

### 1. Pools and the pledge amount

1. **Pledge amount** D = new money charged + Wallet credit applied. Each Pool equals D. The sum of a category's live rows must be ≤ D (#154).
2. `top_up_cents` and the "additional contribution" are removed. The pledge amount replaces them.
3. `Donation.amount_cents` is **new money that the charity keeps**: $0 for a donation paid only with Wallet credit. It is stored next to the pledge amount, which has its own field. `lib/donationTotals.ts` keeps its rule: money totals count `COMPLETED` and `REFUNDED` donations.
4. **Shipping** is a separate fee. It is recorded separately and is outside pledge funding, the Pools, `amount_cents`, `Donor.total_donated` and every money total (#166).
5. **Cash floor.** Neither Wallet credit nor Pool credit can pay for a physical reward. The Wallet credit applied is W = min(available, D − physical prices). A pledge funded only by Wallet credit cannot include a physical reward (#166).
6. **Price lock.** A Pending pledge keeps the reward prices the donor confirmed. Each claim records the amount actually allocated. Every later reversal uses that recorded amount, never the live price (#166).
7. The server enforces the Pools: `createPledge` rejects any category over D (400), and the spend helpers run in a **pool mode** at fulfillment. They check each row against the donation's own Pools and do not subtract from the wallet (#154).
8. **Wallet funding is held.** The wallet-funded part is debited and held when the Pending pledge is created. It is used once at fulfillment, or released once on confirmed non-payment, never on local expiry or sign-out (#162).

### 2. The max rule and reserved money

1. **Max rule.** The Wallet credit that a pooled donation can create = D − the most-used category. A category's "used" amount counts:
   - live rows (claims, votes, contributions of any source);
   - outstanding **Pool credit**;
   - **Unused pool money**.
2. **Unused pool money is reserved** (#160). It is poll or goal money of a live pooled donation that no incentive received and that is neither Pool credit nor Wallet credit. It is computed, not stored: per category, D − live rows − outstanding Pool credit − Wallet credit granted from a failed Payment refund (#171 §3). Polls have no default, so the polls category is always full. **A pooled donation therefore creates no Wallet credit when it is fulfilled.** Wallet credit comes from Wallet refunds, chargebacks of wallet-funded money, failed Payment refunds given as credit, and donations without a pledge.
3. Over a donation's life, each category receives at most D. Spending Wallet credit creates a new pooled pledge, so the same bound holds again for that pledge.

### 3. Auto-allocation

The donor cannot opt out of auto-allocation (#156).

1. The proportional top-up of the donor's own selections in a category is computed at review and fixed at `createPledge` (largest remainder, in integer cents).
2. Goal money with no selection goes to the Channel's **Default goal list**, then to the primary Channel's list (entries eligible for the donation's Channel only), then to the eligible goal closest to completion. This goal is resolved at fulfillment, against live eligibility.
3. Polls have no default. Poll money with no open selection stays Unused pool money.
4. Every `PollVote` and `FundContribution` row records its `source`: `donor`, `auto` or `moderator`. Reward claims are always `donor`.

### 4. Pool credit and Unused pool money

1. **Pool credit** comes from admin reverse-spend of a pooled `donor` or `auto` row, from a per-item poll option or goal reverse, and from a rejected write-in (#159). It belongs to one category. The donor spends it on any open item of that category in the same Event (any Channel, or shared), but never on a physical reward. Spends draw from the oldest source donation first. Each new row links to its source donation (#166). Pool credit never becomes Wallet credit.
2. A **moderator** assigns all of one category's Unused pool money to one open poll option or goal of the donation's Channel, or a shared one. The row has `source = moderator`. Reversing a moderator row returns its money to Unused pool money, never to Pool credit (#160).
3. **Event end** is an explicit admin action that sets `Event.ended_at`. Deactivation does not end an Event. At Event end, outstanding poll and goal Pool credit becomes Unused pool money, and reward Pool credit expires. Both stay "used" in the max rule. These changes are **derived from `ended_at` when read, not stored as transfers**, so "Undo end" restores them without data repair (#172 §12).

### 5. Reversals

Never add up reversed row amounts. Each reversal applies one of these rules:

| Action                                                  | Rows                                                                                                                                                                                     | Wallet credit                                                                                                                                                    | Money total                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Wallet refund** (status `REFUNDED`)                   | Reverse every live row except `FULFILLED` claims. Clear Pool credit and Unused pool money.                                                                                               | + (D − the most-used category after the reversal) − the Wallet credit this donation already granted. A full refund returns D: the card part and the wallet part. | No change                      |
| **Chargeback** (status `CHARGEBACK`)                    | Reverse the same rows. Flag `FULFILLED` claims for an admin. Completed goals stay complete.                                                                                              | + the wallet-funded part − the Wallet credit this donation already granted. A negative result is taken back, capped at the balance.                              | − the remaining `amount_cents` |
| **Payment refund** (cancel an unshipped physical claim) | Reverse the claim. Then shrink the remaining Pools in proportion: Unused pool money first, then live rows and Pool credit (largest remainder; ended polls and completed goals included). | No change                                                                                                                                                        | − the claim's recorded amount  |
| Reverse-spend, per-item reverse, write-in rejection     | Reverse the row.                                                                                                                                                                         | No change: it gives Pool credit, or Unused pool money for a moderator row                                                                                        | No change                      |

1. A **Payment refund** sends money to the donor's original payment method through Stripe (#167). It is the only way money leaves the charity apart from a chargeback.
   - Admin only, on a `COMPLETED` donation with a pledge amount and a Stripe payment, while the donation's Event has not ended.
   - It lowers `amount_cents`, `Donor.total_donated` and D **in place**. The status stays `COMPLETED`, so the counted-status rule is unchanged. The wallet-funded part never changes, so D = `amount_cents` + Wallet credit applied still holds.
   - The whole shipping fee is returned only with the donation's last physical claim that is not cancelled.
   - Accounting changes only after Stripe accepts the refund. The database change and the Stripe call are in separate steps (ADR-0007): a `REQUESTED` record, then the Stripe call with the record id as the idempotency key, then a second transaction. While a record is `REQUESTED`, donation status changes return 409.
   - If an accepted refund later fails, an admin resolves it. "Give as Wallet credit" restores `amount_cents`, `Donor.total_donated` and D, keeps the Pools shrunk, and turns the gap into Wallet credit (`FAILED_PAYMENT_REFUND`). This is the only exception to the reservation rule.
2. No Payment refund is allowed after a Wallet refund or a chargeback. Both are terminal. A later Wallet refund uses the reduced D. A later chargeback lowers the total only by the remaining `amount_cents`.
3. On a charged-back donation, an admin cannot reverse a claim or mark it pending, because that would create Pool credit for money the bank took back. A shipped claim flagged after a chargeback is cleared with Acknowledge.

### 6. Donations without a pledge (legacy rule)

A donation without a pledge amount has no Pools, no Pool credit and no Unused pool money. This covers donations made before the change, admin-added and external donations, and a late payment for an old-shape pledge. Its dollars were spent once, so reversals are one to one (#173 §4). The rule applies to a row whose `donation_id` is null, or whose donation has no pledge amount:

1. Reverse-spend, per-item reverse and write-in rejection: Wallet credit + the row's recorded amount (`REFUND`), a physical claim included.
2. Wallet refund: reverse the live linked rows (`FULFILLED` claims stay), then Wallet credit + their sum (`WALLET_REFUND`).
3. Chargeback: reverse the live linked rows with no credit, then adjust Wallet credit by (sum of live linked rows) − `amount_cents`, capped at the balance (`CHARGEBACK`).
4. No Payment refund. An admin handles it outside the app.
5. A row linked to a donation that was already `CHARGEBACK` before the change gets $0 on a per-item reverse, and reverse-spend is blocked.

### 7. Publishing

1. A reversal, a Pool credit spend, a moderator assignment and a Payment refund each re-publish the affected donation's Tiltify donation message under the same id, without reversed rows and with new rows (#159).
2. A new native message type, `donation.updated`, carries the donation's full current state: status, money, pledge amount, and live allocations with their source. Destinations opt in through `event_types` (#173 §6).
3. Totals are published **whenever a donation's counted amount changes**: a chargeback, a Payment refund, and a failed Payment refund given as Wallet credit. This replaces ADR-0009's rule "publish when the status moves into or out of the counted set".

## Consequences

- **Incentive totals are not money totals.** The sum of a Channel's incentive progress can be several times its money total. A pledge funded only by Wallet credit adds incentive progress and no money, and Pool credit can go to another Channel's items. Every staff page, stat and gauge labels incentive amounts separately from money, and never adds them together. `dono_donated_cents_*` and the Tiltify totals still follow `amount_cents` only (#153, #171).
- **ADR-0009 is amended in part.** Its "Refunds" bullet said ESA never refunds to the payment method. That is still true of a Wallet refund, but a Payment refund now returns money and lowers the totals. The comment at `server/lib/donationTotals.ts:8` and `docs/outbound-events.md` change when the Payment refund ships.
- **`amount_cents` can go down after creation**, but only through a Payment refund, and can go back up only through "Give as Wallet credit". Code that caches a donation's amount must re-read it.
- **Wallet credit is rare.** Most donors see Pool credit or nothing. The wallet page is mostly a Pool credit page (#166).
- **Two accounting rules live side by side**: the pooled rule and the legacy rule. A row's rule follows from its donation, not from a flag. The legacy rule never applies to a donation with a pledge amount.
- **Fixes on the way:** wallet-only donations no longer count twice toward the money total (#158). A Wallet refund adds credit instead of taking it (#163). Existing `wallet-<uuid>` donations go to $0 and shipping moves out of `amount_cents` in the transition (#173 §5).
- **Unused pool money needs a person.** The charity keeps it, and it counts toward no incentive until a moderator assigns it. The moderator list and `dono_pool_unused_cents_by_channel` show it.

## Alternatives considered

- **One dollar counts once (split the pledge across categories).** This was the model before the change. Rejected at charting: donors and the stream expect a donation to count toward a reward, a poll and a goal together, as Tiltify does.
- **Leftover pool money becomes Wallet credit.** Rejected: unused poll money would always become Wallet credit, and a donor could spend the same dollars on polls a second time. The reservation rule (§2) prevents this.
- **Reversed rows add their amounts back to the wallet.** Rejected: a $10 donation can back $30 of rows, so this creates credit that never existed. Pool credit stays in its category.
- **Re-vote credit limited to the same poll.** Replaced by Pool credit for a whole category in the Event, so that a donor whose write-in was rejected can still choose.
- **Credit pays for physical rewards.** Rejected: the replacement reward would charge shipping a second time.
- **Store Event-end conversions as transfers.** Rejected: "Undo end" would need data repair. The conversions are derived from `ended_at`.
- **Merge Pending pledges and Donations into one table.** Rejected: many donation queries have no status filter, abandoned checkouts would become donations, and a pledge's donor is not always known at checkout (#172 §2).
- **A feature flag for the transition.** Rejected: a hard switch between Events, with a backup and a write barrier, as in ADR-0002 (#173 §9).
