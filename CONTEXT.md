# CONTEXT

Domain language for esa-dono-ui. Use these words in code, issues, tests and docs. The
"Avoid" column is guidance, not a ban: prefer the defined term so a reader never has to
guess which concept is meant.

## Glossary

| Term                 | Means                                                                                                                                                                                                        | Avoid                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **Event**            | A charity event: a marathon, or a one-day stream event. Parent of Channels. An admin ends it with an explicit action; deactivating it does not end it.                                                       | occasion, campaign, team campaign |
| **Channel**          | One stream within an Event.                                                                                                                                                                                  | stream, campaign                  |
| **Primary channel**  | The Channel an Event routes a donation to when the donation names no Channel. An active Event always has an active one.                                                                                      | default channel                   |
| **Slug**             | The lowercase, URL- and routing-safe name of an Event or Channel (`esa-summer-2025`), unique across both. Used in `/donate/<event>/<channel>` and AMQP routing keys.                                         | handle, key, short name           |
| **Webhook message**  | One outbound notification that something happened (for example, a donation was made).                                                                                                                        | event, webhook event              |
| **Destination**      | Where webhook messages are sent: an HTTP URL or a RabbitMQ exchange.                                                                                                                                         | endpoint, event destination       |
| **Delivery**         | One queued attempt to send one webhook message to one Destination.                                                                                                                                           | job, event delivery               |
| **Endpoint failure** | A send that the receiving side (URL or broker) rejected or did not answer, including every HTTP 4xx. Retried forever, in order (ADR-0007). "Endpoint" here means the receiver, never the Destination record. | error, transient failure          |
| **Message failure**  | A message that cannot be sent at all (empty or unparseable payload). Marked `FAILED`; the queue moves on.                                                                                                    | poison message, permanent failure |

## Money and incentives

| Term                  | Means                                                                                                                                                                                                                                                                                                                 | Avoid                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Pledge amount**     | The amount a donor commits to at the start of a donation. It sets the size of each Pool. Part of it can be paid with Wallet credit, so it can be more than the money charged.                                                                                                                                         | declared amount, intended amount, top-up      |
| **Draft pledge**      | A Pledge amount and incentive selections that the donor has not yet sent to checkout. The donor can leave and resume it.                                                                                                                                                                                              | cart, in-progress pledge                      |
| **Pending pledge**    | A pledge sent to checkout awaiting confirmed payment. Its applied Wallet credit is held until payment settles or non-payment is confirmed. A late confirmed payment fulfils it; cancellation or expiry alone does not prove non-payment.                                                                              | open pledge, order                            |
| **Pool**              | The budget of one incentive category (rewards, polls or goals) in one pledge. Each Pool equals the Pledge amount, so one dollar can back a reward, a poll vote and a goal at the same time.                                                                                                                           | allowance, budget split                       |
| **Wallet credit**     | Money a donor gave that no incentive has used yet. The donor can spend it later.                                                                                                                                                                                                                                      | balance (alone), unallocated donation, credit |
| **Auto-allocation**   | Moving Pool money the donor did not direct to incentives: first to the donor's own selections in that category, then (goals only) to the Default goal list. The donor cannot turn it off.                                                                                                                             | auto-spend, top-up, fallback                  |
| **Pool credit**       | Pool money the donor can spend again in one category of one pledge, after an item was reversed or a write-in was rejected. It can go to any open item in that category. It never becomes Wallet credit. When the Event is ended, poll and goal Pool credit becomes Unused pool money, and reward Pool credit expires. | re-vote credit, refund, wallet credit         |
| **Unused pool money** | Poll or goal Pool money of a pledge that no incentive received and that is not Pool credit. It is not Wallet credit: the donor cannot spend it. A moderator can assign it to one open poll option or goal.                                                                                                            | unallocated money, leftover, orphan money     |
| **Refund**            | Giving a donation back to the donor as Wallet credit. The charity keeps the money, so the Money total does not change. A refund never goes to the card; a chargeback is the bank taking money back.                                                                                                                   | reversal (alone), forfeit                     |
| **Default goal list** | A Channel's ordered list of goals that receive goal-Pool money the donor did not direct. The first goal on the list that can still take money receives it. Polls have no default.                                                                                                                                     | default goal, fallback goal, catch-all        |
| **Money total**       | The money raised by a Channel or an Event. Incentive progress is not money: the sum of incentive totals can be more than the money total.                                                                                                                                                                             | amount raised (for incentives)                |

## "Event" versus "webhook message"

**Event** always means the charity event. A notification sent to a Destination is a
**webhook message**, and its kind is its **message type** (`donation.created`,
`incentive.enabled`, …). Code under `server/services/webhooks/` uses "message", and an
ESLint warning flags new `Event`-named identifiers there.

Exceptions, because they are external contracts:

- HTTP header `X-Webhook-Event` and AMQP header `x-webhook-event`.
- Admin API field `event_types` on a Destination, and the delivery-log field `event_type`.
- Database column `event_type` (mapped to `message_type` in Prisma).

"Webhook event" is the industry term for these, so outside consumers are not confused by it.

See `docs/adr/0006-webhook-vocabulary.md`.

## Event and Channel identity

- An **Event** contains one or more **Channels**. Every Channel belongs to exactly one Event.
- Ids are UUIDs.
- A **slug** cannot change while its Event or Channel is active. Overlays bind to it, and published links contain it.

See `docs/adr/0008-event-channel-identity.md`.

## Tiltify mapping

Destinations with the Tiltify-compatible payload format (ADR-0009) speak Tiltify's words:

| Tiltify                         | Ours                                            |
| ------------------------------- | ----------------------------------------------- |
| team campaign (`team_event_id`) | **Event**                                       |
| campaign (`campaign_id`)        | **Channel**                                     |
| donation                        | **Donation** (routed to a Channel)              |
| reward claim                    | **RewardClaim** (one per unit)                  |
| poll / poll option              | **Poll** / **PollOption**                       |
| target                          | **FundGoal** (goal)                             |
| fact (`total_amount_raised`)    | the money total of a Channel or an Event        |
| `donor_name: "Anonymous"`       | no display name, **or** hidden from the overlay |

**Hidden from overlay** (`hidden_from_overlay`) is not the same as **moderated**. Hidden removes the donor's name and message from the stream. Moderated only records that a person reviewed the donation.
