# Admin guide: set up a new Event

Use this guide to take a new charity Event from planning to accepting donations.
It assumes the donation platform is already installed. For a new installation,
have the technical operator complete the [deployment guide](deployment.md) first.

**Setup order:** confirm access and payments → create the Event → create its
Channels → add incentives and Default goal lists → connect staff and stream tools
→ rehearse → activate and publish links.

## 1. Gather the details and confirm access

Agree on these before entering data:

- Event name and final public slug, for example `ESA Summer 2027` and
  `esa-summer-2027`.
- Each Channel's name and slug, for example `ESA Summer 2027 — Stream 1` and
  `esa-summer-2027-stream-1`. Channel names must also be unique across the site.
  A Channel is one stream within the Event. Even a single-stream Event needs one.
- Which Channel is the **Primary channel**: the destination for an Event donation
  link that does not name a Channel.
- Rewards, poll questions and options, goal amounts, and which incentives are shared
  across the Event rather than limited to one Channel.
- Opening time, staff responsibilities, reward fulfillment arrangements, and the
  person who can resolve payment or stream-tool problems.

Slugs must be 3–64 characters, with lowercase letters, digits and single hyphens
between words. They must be unique **across both Events and Channels**, not just
within this Event. Avoid reserved names such as `admin`, `donate` and `wallet`.
Include the Event name/year in Channel slugs to avoid collisions with older Events.
Finalize slugs before publishing links or configuring stream tools: an active Event
or Channel cannot change its slug.

### Sign in

1. Open `/admin` on the correct site. Confirm whether it is production or staging.
2. Sign in through `/wallet` with an admin account, then return to `/admin`; or enter
   the admin API key supplied by the technical operator.
3. Confirm that the admin dashboard loads data without an authorization error.

The API-key login takes the raw key, **without** the `key_admin_` prefix. Treat it
as a password. Do not put it in public links, screenshots or handover notes.
A moderator account alone cannot perform all the steps in this guide.

### Ask the technical operator to confirm production readiness

These are installation settings, not fields in the Event form:

| Check                 | Required result                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public URL            | HTTPS works; `APP_BASE_URL` points to this site so email links and payment returns reach the right environment.                                                                                                                                                      |
| Stripe                | Live payments use the intended Stripe account, live secret key and matching webhook signing secret. Staging uses test credentials.                                                                                                                                   |
| Payment notifications | The Stripe endpoint is `/api/webhooks/stripe`; its subscriptions include completed/expired Checkout Sessions, asynchronous payment success/failure and refund notifications. See [Stripe webhook registration](webhooks-and-metrics.md#stripe-webhook-registration). |
| Donor email           | SMTP and the sender address work; an actual magic-link email reaches a test mailbox. Without SMTP, links are only logged on the server.                                                                                                                              |
| Currency and shipping | The configured currency is correct. If offering physical rewards, confirm shipping countries and any Stripe shipping rate before testing.                                                                                                                            |
| Recovery              | Database and reward-image storage persist, a recent backup exists, and an operator is available for launch.                                                                                                                                                          |

A working admin dashboard does not prove that payments or email work. Do not launch
with missing payment configuration or disabled webhook signature verification.

## 2. Create the Event

1. Open **events** (`/admin/events`).
2. Click **+ new event**, enter **name** and **slug**, then **save**. A blank slug
   generates one from the name; check the saved value before sharing it.
3. Leave the Event inactive while preparing it. New Events start inactive because
   they do not yet have a Primary channel.
4. Record the Event's UUID and slug for the stream-tool operator.

Create a new Event for a new marathon. Do not rename an old Event to reuse its
history. Shared incentives belong to exactly one Event; recreate any incentives
needed from an earlier Event under the new one.

**Inactive is not a private preview.** Prepare test data on a separate staging
installation. An active Channel can appear in the public donation picker and accept
new pledges even while its Event is inactive. Active incentives can also appear in
public incentive lists regardless of parent activity. Keep production Channels and
unannounced incentives inactive until they are ready for public use. Deactivation
does not cancel existing Pending pledges or payments.

## 3. Create Channels and choose the Primary channel

1. Open **channels** (`/admin/channels`).
2. Click **+ new channel** for each stream. Enter **name** and **slug**, and select
   the new **event** explicitly—do not rely on the default owner.
3. **Uncheck active before saving.** New Channels default to active. Check the
   saved name, slug and Event on every Channel.
4. In **events**, click **edit** on the Event, choose **primary channel**, then
   **save**. Selecting an inactive Channel is allowed, but it must be active before
   the Event can be activated.
5. Record each Channel's UUID and slug, and check the intended donation links:

   ```text
   /donate/esa-summer-2027
   /donate/esa-summer-2027/esa-summer-2027-stream-1
   ```

The first link routes to the Primary channel; the second names a specific Channel.
Use the full site URL when sharing either link. Test in a fresh browser session so
an existing donor draft does not affect the result.

An Event can only be activated with an **active Primary channel belonging to that
Event**. Activate the Primary channel before activating the Event at launch. Do
not leave an active Event without an active Primary channel; select another active
one before retiring the current Primary channel.

## 4. Add incentives

Use **rewards**, **polls** and **goals** in the admin sidebar. Click **+ new reward**,
**+ new poll** or **+ new goal**. In each form's **channel** selector, choose a
Channel or, for example, **shared (every channel of ESA Summer 2027)**. Check
its owning Event and optional Channel:

- **Channel-specific:** available on that Channel.
- **Shared:** belongs to this Event, has no Channel, and is available on every
  Channel of this Event—not on other Events.

Do not assume choosing “shared” makes an incentive available across future Events.
Check the owner before saving, especially if several Events exist on the site: the
default shared owner may be the previous active Event. Existing incentives cannot
move between Events; recreate them if you chose the wrong one.

| Page                           | What to prepare                                                                                                                                                   | What to verify before opening                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **rewards** (`/admin/rewards`) | **Title**, description/image, **Cost (dollars)**, **Quantity (blank=unlimited)** and **type** (`DIGITAL`, `PHYSICAL`, `SHOUTOUT` or `CUSTOM`).                    | Donors can understand what they receive. Prices, stock, claim details and fulfillment arrangements are correct. For physical rewards, test shipping in Stripe Checkout. |
| **polls** (`/admin/polls`)     | **Title**, description, optional **ends at**, and whether to **allow custom entries**. Save the poll, then use **New option...** → **add** to create its options. | There are usable options. Decide who reviews write-ins; review **auto-approve write-ins** and the closing time.                                                         |
| **goals** (`/admin/goals`)     | **Title**, description and **Target (dollars)**.                                                                                                                  | The target and Channel/shared ownership are correct; the goal is open when it should receive allocations.                                                               |

The forms default **active** to checked. Uncheck it for anything not ready to open,
then **save**. Create later incentives in advance where useful, but keep them
inactive until they should be available.

### Set a Default goal list for every Channel

After creating goals, return to **channels** → **edit** → **Default goal list**.
Use **Add goal…** to add goals from that Channel or shared goals in the same Event.
Use **↑** / **↓** to set their priority, then **save**. Do not select a shared goal
from a different Event even if it appears in the chooser; saving will be rejected.

Only active, incomplete goals can be added through the chooser. If keeping goals
inactive during preparation, finish the list at launch after enabling the goals
and before activating Channels.

After auto-allocation to the donor's own goal selections, the first listed goal
that can still accept money receives remaining goal-Pool money. If no listed goal
is eligible, automatic fallback can still choose another goal. A newly created
list is empty; this does **not** disable auto-allocation. Check **Current goal-Pool
recipient** on the Channel card and the fallback information in the editor.
Payment completion checks eligibility again; the preview reserves nothing.
Recheck the list when goals close or reach their targets.

### Understand the totals you will test

Each pledge has independent reward, poll and goal **Pools**, each equal to the
pledge amount. For example, a $10 pledge can back a $10 reward, $10 of poll votes
and $10 toward a goal. That is not $30 raised. Unused poll/goal selections can be
auto-allocated; reward claims are not automatically chosen for a donor.

**Money totals count money, not the sum of incentive progress.** The home page's
headline and goal are also not Event settings: its money total is platform-wide,
and its goal comes from `CAMPAIGN_GOAL_CENTS`. Check Event and Channel totals in
the corresponding stream tools rather than expecting a new Event to reset the
home page.

### Optional: auctions

If the Event uses auctions, configure them under `/admin/auctions` and enable the
`auctions` flag under **feature flags** (`/admin/feature-flags`). Have the auction
owner rehearse bidding, closing and winner payment separately. Auctions are not
one of the three pledge Pools. Leave the flag disabled if auctions are not used.

## 5. Prepare staff and public messages

- Under **donors** (`/admin/donors`), create or find staff accounts and assign the
  required role. Give moderators `MODERATOR`; reserve `ADMIN` for people who need
  administrative access. Staff do not need to donate to receive a role.
- Have each moderator sign in and open `/moderate`. Confirm their Channel filters,
  donation review, poll write-in review and reward-claim workflow. Staff guidance
  is under **help** (`/admin/help` or `/moderate/help`).
- Review **blocked words** (`/admin/blocked-words`) if allowing poll write-ins.
  This list blocks whole-word, case-insensitive matches in custom poll entries;
  it is not a general filter for all donor comments.
- Review **broadcast banner** (`/admin/broadcast`). Clear old Event notices or
  publish the correct announcement. The banner is site-wide, not Event-specific.
- Agree who handles donor support, physical reward fulfillment and payment issues.
  Marking a donation reviewed does **not** hide it from the stream overlay.

Staff roles, feature flags, blocked words and the broadcast banner are site-wide.
Check the effect on other Events before changing them.

## 6. Connect the donation reader and stream overlay

Skip this section only if the Event will not use external stream tools.
Coordinate it with the operator of Kollekt and the NodeCG overlay.

1. Open **destinations** (`/admin/destinations`, page title **webhooks**). Reuse a
   healthy existing Destination if it is already the intended connection; do not
   create duplicate connections merely because the Event is new.
2. For Kollekt and the ESA overlay, use a **RabbitMQ** Destination with
   **Tiltify-compatible** payload format. Confirm the AMQP URL and exchange with
   the operator; the default exchange name for this format is `tiltify`.
3. Save and confirm the Destination is active. In this format, routing keys are
   computed from slugs; the form's message-type selection and manual routing key
   are not used.
4. Give the operator the **new Event and Channel UUIDs and slugs**. The Event maps
   to a Tiltify “team campaign”; a Channel maps to a “campaign”. Old Event IDs in
   the overlay configuration will not switch automatically.
5. Confirm the consumers use the same broker and the platform's Tiltify-compatible
   REST API. Kollekt's API base URL must end in `/api/tiltify/` **with the trailing
   slash**. The overlay must identify the correct Channel as its current stream.
6. Click **test**, then **log** on the Destination to check delivery. Follow this
   with a donation rehearsal that is visibly received by the actual reader and
   overlay.

A successful RabbitMQ delivery proves broker acceptance, **not** that the reader
or overlay processed it. Verify the displayed donation, incentives and matching
Event/Channel money totals. Include a shared incentive if the Event uses them.

For consumer settings, HTTP Destinations and stalled deliveries, use
[outbound webhook messages](outbound-events.md#consumer-setup) and
[API consumers](api-consumers.md).

## 7. Rehearse on staging

Use a separate database, test Stripe credentials and test stream-tool connections.
Never run a demo reset, bulk simulator or seed script against production to “start
fresh”. They are not Event setup steps.

Activate the rehearsal Event and its Channels on staging, then verify:

- [ ] The Event donation link selects the intended Primary channel.
- [ ] Each Channel link selects the right Channel in a fresh browser session.
- [ ] Each Channel shows only its own incentives and this Event's shared incentives.
- [ ] A donor can sign in, set an amount, choose incentives, review the plan and
      complete Stripe test Checkout.
- [ ] A successful payment produces one donation with the expected claims, votes
      and goal contributions. Return from Checkout and open the emailed wallet
      link to check the donor's view.
- [ ] A donation with no incentive selections follows the expected Default goal
      behavior. The money total rises by the donation's new money, not by the sum
      of its Pools.
- [ ] Cancelling Checkout does not show a completed donation. Check any pending
      pledge through **pledges** (`/admin/pledges`); do not assume cancellation
      alone means payment is impossible or Wallet holds can be released.
- [ ] Physical reward Checkout collects the expected shipping details/charge, if
      physical rewards are offered.
- [ ] Moderators can find and review the donation and any pending write-ins.
- [ ] The actual reader and overlay receive the donation on the correct Channel,
      with matching money and incentive amounts.
- [ ] Destination logs show no growing backlog or repeated failures.

**“Add donation” is not a Stripe test.** `/admin/simulate` records a donation without
charging money; its ordinary form credits Wallet credit rather than creating a
pooled pledge. It still affects stored totals and can notify donors and consumers.
Use it only on staging for synthetic tests, or for an approved real external
donation. See [simulating donations](simulating-donations.md).

## 8. Activate production and publish links

At the agreed opening time:

1. Confirm the production records match the approved rehearsal: names/slugs,
   ownership, prices, stock, poll options and Default goal lists.
2. Confirm staff are signed in and the payment/stream-tool operator is available.
3. Enable the incentives opening now; leave later ones inactive. Finish and save
   each Channel's Default goal list if its goals were inactive during preparation.
4. In **channels** → **edit**, check **active** and **save** for the production
   Primary channel and any other Channels opening now. This opens those Channels
   to new pledges; do not do it before the agreed opening time.
5. Confirm the Event's Primary channel selection, then click **activate** on its
   Event card to make the Event-slug links available.
6. Check the public donation links in a fresh browser session and confirm that
   the intended incentives can be selected. Verify reader and overlay scope.
7. If the payment operator requires a final live-payment check, agree on it first:
   it charges real money and enters real accounting. Do not substitute a synthetic
   donation on production.
8. Publish the approved Event/Channel links in stream panels, chat commands and
   announcements. Monitor the first real donations and Destination logs.

Activation is manual; this workflow does not schedule an opening time. A banner
announcing that donations are closed is not a substitute for inactive Channels.

### Ready-to-open checklist

- [ ] Correct production URL, live payment configuration, signed Stripe webhook
      and working donor email.
- [ ] New Event created, final slugs recorded, and correct Primary channel selected.
- [ ] Event and intended Channels active; future Channels remain inactive.
- [ ] Incentive owners, prices, stock, options, targets and opening states checked.
- [ ] Every opening Channel's Default goal list and fallback behavior reviewed.
- [ ] Moderators can sign in; support and fulfillment owners are assigned.
- [ ] Reader/overlay use the new IDs/slugs and have passed a real consumer rehearsal.
- [ ] No unresolved payment, donor-email or webhook-delivery blocker.
- [ ] Public links checked and launch approved by the responsible admin.

## Common setup blockers

| Symptom                              | What to check                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event will not activate              | Select an active Primary channel belonging to that Event. If reusing an ended Event intentionally, an admin must **Undo end** before reactivation; normally create a new Event. |
| Slug is rejected                     | Check length, lowercase letters/digits/hyphens, reserved names, and whether any Event or Channel already uses it.                                                               |
| Slug cannot be edited                | Active records lock their slug. Do not deactivate a live stream just to rename it; coordinate link and consumer changes first.                                                  |
| Donation link is unavailable         | Confirm the exact slugs and that the Event and requested Channel are active. Retest without an existing browser draft.                                                          |
| Wrong or missing incentives          | Check Event ownership, Channel/shared ownership and active state. Shared does not mean shared across Events.                                                                    |
| Goal receives unexpected allocations | Review the Channel's ordered Default goal list and the current fallback recipient; do not compare total incentive progress with money raised.                                   |
| Reader or overlay is empty/stale     | Check its Event/Channel IDs, slugs, broker/API settings and Destination log. A successful ping alone is not end-to-end proof.                                                   |
| Donor email never arrives            | Ask the operator to check SMTP, sender settings and `APP_BASE_URL`; server-log links are a development fallback, not working donor email.                                       |

Do not use **End Event**, **sweep credits**, donation reassignment or database resets
to prepare a new Event. These change existing donor history or credit behavior and
are separate operations.
