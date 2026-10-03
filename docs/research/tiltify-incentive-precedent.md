# Tiltify precedent: how one donation counts toward a reward, a poll and a target

Research for esamarathon/esa-dono-ui#152. Sources were retrieved on 2026-10-03.
Each statement has a label. **Confirmed** means that a cited primary source states it. **Inference** means that it is our reading of the evidence and that no source states it directly.

## Answer

- **Confirmed:** Tiltify lets one donation claim rewards, vote in a poll and fund a target at the same time. Its help center says "the same donation can count towards the reward cart, a target, and a poll" [H1].
- **Confirmed:** Rewards stack. The donor UI requires `amount >= Σ(quantity × reward.amount)` [D1]. Polls and targets are limited to **one poll option and one target per donation** [H1]. The v5 Donation object has scalar `poll_option_id` and `target_id` and an array of `reward_claims` [A1].
- **Confirmed:** Tiltify has no per-incentive allocation field. The Donation has one `amount`, and the API does not record which part went where [A1].
- **Inference (strong):** Tiltify does not split a donation. The full amount counts toward the chosen poll option and the chosen target, on top of covering the rewards. The campaign total rises only by `amount`. The proposed ESA flow follows the same principle. ESA allows several polls and goals, so each category gets a pool that the donor divides, whereas Tiltify allows one choice per category, which then gets the whole amount.
- **Not documented:** Tiltify reports a refund as `payment_status: "cancelled"` and sends `fact_updated` when `amount_raised` changes [A2][A3]. No source says whether incentive totals or reward stock are reversed.

## 1. Can one donation combine incentives?

| Claim                                                                                                                                                                                                                                              | Status    | Source               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------- |
| "You may choose multiple rewards, a poll and a target all in one donation."                                                                                                                                                                        | Confirmed | [H1]                 |
| "In addition to rewards, donors can select one of each a target and a poll."                                                                                                                                                                       | Confirmed | [H1]                 |
| "A single donation can go to support a single poll option."                                                                                                                                                                                        | Confirmed | [H1], [H2] (current) |
| "Reminder: the same donation can count towards the reward cart, a target, and a poll."                                                                                                                                                             | Confirmed | [H1]                 |
| Current wording: "Donors can select multiple rewards and participate in active polls as part of a single donation." "A donation can qualify for rewards, contribute toward campaign milestones, and participate in active polls at the same time." | Confirmed | [H2]                 |
| "With our new Donation Flow on Tiltify, donors can redeem a reward AND donate towards your poll!"                                                                                                                                                  | Confirmed | [H3]                 |
| A real Tiltify webhook (ESA, 2024-02-17, $40.00) carries a `reward_claims` entry and a `target_id` on the same donation.                                                                                                                           | Confirmed | [C1]                 |
| The v5 OpenAPI Donation example sets `reward_claims`, `poll_id`/`poll_option_id` and `target_id` together on one donation.                                                                                                                         | Confirmed | [A1]                 |

**Targets in the current donor UI.** The 2025 donate-form bundle has no target input. Its `create_donation_cart` and `create_donation_reference` mutations accept only `pollOptionId: ID` (one value) and `rewards: [DonationRewardInput]` (a list) [D1]. The current help article [H2] does not mention targets. The Targets help article now returns 404; the last archived copy is from 2025-05-24 [H4]. The v5 API still exposes `target_id` and `/targets` [A1]. **Inference:** Tiltify may have retired or hidden target selection in its newer donation flow. Data from older donations, such as [C1], still carries `target_id`.

## 2. Full amount or split?

**Confirmed facts:**

- The v5 `Donation` has exactly one money field, `amount` ("The amount donated"). `RewardClaim` has only `id`, `reward_id` and `quantity`, with no amount. `poll_option_id` and `target_id` are bare ids with no amount [A1]. The private and cause-scoped Donation schemas add donor PII and payment fields, but no allocation field [A4].
- `Poll.amount_raised` is "Amount Raised by this poll". `PollOption.amount_raised` is "Amount Raised by this poll option". `Target.amount_raised` is "Amount Raised by this target" [A1].
- Help-center text on targets: "Targets can set their own totals and must be donated specifically in order to complete their specific goal" [H4]. On polls: "every dollar DOES count", and "Donors can help progress the poll toward its goal through their contributions" [H3].
- Rewards cost money from the donation: "If you select a reward above your donation amount, your donation will increase to that amount AND you will get that reward" (2019) [H5]. The current donor UI computes `rewardAmount = Σ over claims of quantity × reward.amount`. It uses `max(donation minimum, rewardAmount)` as the minimum amount, and shows a "Reward amount different" dialog with "Remove reward or update amount" [D1].

**Inference:**

1. A donation stores no per-incentive split, so Tiltify can only attribute a donation to a poll option or a target at its full `amount`. Any partial value would have to be stored somewhere, and the public, private and cause schemas have no such field. Tiltify's own wording ("the same donation can count towards the reward cart, a target, and a poll") is consistent with full attribution and does not mention a split.
2. A $10 donation with a $5 reward, a poll vote and a target therefore most likely adds $10 to the poll option, $10 to the target and $10 to the campaign total. The reward stock drops by the claimed quantity. The reward cost does not reduce what the poll or the target receive.
3. We did not verify this against live numbers. The v5 API returns 401 without an application token, and we had no token. To prove it, make a test donation on a Tiltify sandbox campaign and compare `PollOption.amount_raised` and `Target.amount_raised` before and after. Because of this, the conclusion is a strong inference, not a confirmed fact.

## 3. Effect on each incentive

| Incentive            | Tiltify behaviour                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Reward               | `Reward.amount` = "Amount needed to claim this reward". `quantity` and `quantity_remaining` track limited stock [A1]. Several rewards and quantities per donation; the donation amount must cover Σ quantity × amount [D1][H1]. The donor UI holds reserved stock for 10 minutes (`earliestReservedAt + 600000 ms`) and shows "Rewards no longer available" or a quantity error when stock runs out [D1]. | Confirmed                                                             |
| Poll                 | One option per donation [H1][H2]. Tracked by `PollOption.amount_raised` and `Poll.amount_raised`, with an optional `goal` [A1][H3]. Polls have at most 5 options [H3].                                                                                                                                                                                                                                    | Confirmed                                                             |
| Poll credit amount   | Full donation amount.                                                                                                                                                                                                                                                                                                                                                                                     | Inference (§2)                                                        |
| Target               | One per donation [H1]. Tracked by `Target.amount_raised` toward `Target.amount`, with `ends_at` [A1][H4].                                                                                                                                                                                                                                                                                                 | Confirmed                                                             |
| Target credit amount | Full donation amount.                                                                                                                                                                                                                                                                                                                                                                                     | Inference (§2)                                                        |
| Campaign total       | `total_amount_raised` / `amount_raised` on the Fact counts the donation once [A1].                                                                                                                                                                                                                                                                                                                        | Confirmed (field); once-only is inference (one `amount` per donation) |

## 4. Refunds and chargebacks

- **Confirmed:** `donation_updated` "will combine new donations, as well as donations being moderated and refunded". `fact_updated` fires on changes to a Fact, including "the amount_raised by all of the Donations toward that Fact" [A2].
- **Confirmed:** In Relay payloads, `data.payment_status` is one of `pending`, `completed` or `cancelled`. "When the donation has been cancelled. This means the payment associated with the donation has been refunded to the donor." [A3]
- **Not found:** No Tiltify source says whether a refund lowers `PollOption.amount_raised` or `Target.amount_raised`, or whether it returns reward stock (`quantity_remaining`). No source mentions chargebacks or disputes. A help-center search for "chargeback" returned no results, and "refund" returned only unrelated articles [H6].
- **Inference:** Tiltify defines incentive `amount_raised` as an amount raised by donations. A refunded donation is no longer money raised, so the incentive totals most likely drop together with the Fact total. This is unverified.
- **Consumers:** kollekt and esa-layouts-v2 do not compute incentive totals. They re-read `amount_raised` from the API: kollekt calls `SyncPoll`/`SyncTargets` on each donation [C2], and layouts polls `/polls` and `/targets` [C3]. Whatever the source reports is what they display. Neither consumer reads `payment_status` [C2][C3].
- **ESA difference:** ESA refunds only to the donor's wallet, and refunded money stays counted (ADR-0009 §Refunds, PRD-0002 §E7). Tiltify refunds to the payment method. This difference is a deliberate ESA choice, not a Tiltify precedent.

## 5. Relevance to the proposed ESA flow

| Aspect                 | Tiltify                                                     | Proposed ESA flow                                                                                                      |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rewards                | Cart; donation ≥ Σ costs (confirmed)                        | Reward pool = declared amount; Σ costs ≤ amount                                                                        |
| Polls                  | One option, full amount (choice confirmed; amount inferred) | Poll pool = declared amount, split across several polls                                                                |
| Targets/goals          | One target, full amount (choice confirmed; amount inferred) | Goal pool = declared amount, split across several goals                                                                |
| Money raised           | `amount` once (confirmed field)                             | Declared amount once                                                                                                   |
| Allocation on the wire | None (confirmed)                                            | Needs per-item amounts. ESA already sends `target_contributions[].amount` (PRD-0002 §T, an ESA extension, not Tiltify) |

**Inference:** For a single poll and a single target, Tiltify and the proposal give the same numbers: each incentive gets the full amount, and the money raised rises once. The proposal is a generalisation. With several polls or goals, the donor divides each category's pool, which Tiltify cannot express. Tiltify consumers read only the scalar `poll_option_id`/`target_id` and the incentive `amount_raised` from the API. They do not add donation amounts themselves, so pool-based totals in the ESA API are shown as they are [C2][C3]. ADR-0009 already sends the first item in the scalar fields and the full set in `poll_votes`/`target_contributions`, which are ESA extensions read by kollekt#35 [C2].

## Sources

Tiltify primary sources:

- [A1] Tiltify v5 public OpenAPI spec, `https://v5api.tiltify.com/api/public/openapi` (info.version 1.0). Schemas used: `Donation` and its example, `RewardClaim`, `Reward`, `Poll`, `PollOption`, `Target`. The rendered spec is at `https://developers.tiltify.com/api-reference/public`.
- [A2] Tiltify developer docs, "Types of Events", `https://developers.tiltify.com/docs/webhooks/subscriptions/types-of-events`.
- [A3] Tiltify developer docs, "Using Relays" (`payment_status`, `reward_claims`), `https://developers.tiltify.com/docs/webhooks/relays/using-relays`; "Reconciliation" (example `payment_status: "cancelled"`), `https://developers.tiltify.com/docs/webhooks/relays/reconciliation`.
- [A4] Tiltify private and cause OpenAPI specs, `https://v5api.tiltify.com/api/private/openapi` and `https://v5api.tiltify.com/api/cause/openapi`. The cause `Donation` schema has no allocation field.
- [H1] Tiltify help center, "Donating on Tiltify", archived 2021-09-27 and 2024-03-14, `https://web.archive.org/web/20210927000137/https://info.tiltify.com/support/solutions/articles/43000543097-donating-on-tiltify`.
- [H2] The same article, current version, `https://info.tiltify.com/support/solutions/articles/43000543097-donating-on-tiltify`; and "Campaign Polls", `https://info.tiltify.com/support/solutions/articles/43000018390-campaign-polls`.
- [H3] Tiltify help center, "Adding Incentives: Polls", `https://info.tiltify.com/support/solutions/articles/43000011861-adding-incentives-polls`; "Campaigns: Incentives", `https://info.tiltify.com/support/solutions/articles/43000694055-campaigns-incentives`.
- [H4] Tiltify help center, "Adding Incentives: Targets (formerly Challenges)", archived 2025-05-24, `https://web.archive.org/web/20250524132904/https://info.tiltify.com/support/solutions/articles/43000011862`. The live URL now returns 404.
- [H5] "Donating on Tiltify", archived 2019-12-08, `https://web.archive.org/web/20191208123720/https://info.tiltify.com/support/solutions/articles/43000543097`.
- [H6] Help-center search, `https://info.tiltify.com/support/search/solutions?term=chargeback` (no results) and `?term=refund`.
- [D1] Tiltify donate-form production bundle, `https://site-assets.tiltify.com/donate/assets/index-BALMXBfI.js`, retrieved 2026-10-03. Relevant parts: the `create_donation_cart` / `create_donation_reference` GraphQL mutations (`pollOptionId: ID`, `rewards: [DonationRewardInput]`, no target), the `rewardAmount` reducer (`quantity × reward.amount.value`, summed), the minimum-amount helper, the "Reward amount different" dialog, and the reward reservation check. These are minified client code, so the server may enforce more rules.

Consumer code (real Tiltify payloads):

- [C1] `esamarathon/ESATiltifyBridge@a63d98f`, `Tests/Webhooks/Donation/RegressionTests.cs`, `DirectDonation1`: a real (redacted) `public:direct:donation_updated` payload from 2024-02-17 with `reward_claims` and `target_id` on one $40.00 donation.
- [C2] `esamarathon/kollekt@4eb26ce`, `Kollekt.Rabbit/IngestionService.cs` (`MakeRedeems`, `MakePollRedeem`, `MakeTargetRedeem`) and `Kollekt.Shared/Tiltify/Models/TiltifyDonation.cs`. The pre-ESA model (`524f276`) has only the scalar `poll_option_id`/`target_id` and `reward_claims`.
- [C3] `esa-layouts-v2@009487a`, `src/extension/fundraising.ts` (reads `Poll`/`PollOption.amount_raised` from the API) and `src/extension/util/target-data.ts`.
- `tiltify_dashboard/tiltify_api.py` (`donation_to_vm_row`) reads `reward_claims[].quantity` and the scalar `poll_id`/`target_id`. It uses `amount` only once per donation.

ESA internal documents (context only, not a Tiltify precedent): `docs/adr/0009-tiltify-compatible-messages.md`, `docs/adr/0010-tiltify-compatible-rest-api.md`, `docs/prd/0002-outbound-webhook-queue-and-tiltify-compatibility.md`.
