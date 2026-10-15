import Card from '../../components/Card';

type Role = 'admin' | 'moderator';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mb-6">
      <h2 className="font-display text-2xl uppercase text-off-white mb-3">{title}</h2>
      <div className="space-y-3 font-body text-sm text-off-white/70">{children}</div>
    </Card>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <strong className="text-off-white">{children}</strong>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-off-white/10 px-1.5 py-0.5 rounded">{children}</code>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | React.ReactNode)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="text-left px-3 py-2 border-b border-off-white/20 text-off-white/55 uppercase tracking-wider"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-off-white/10">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-off-white/70 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StaffHelp({ role }: { role: Role }) {
  const isAdmin = role === 'admin';

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="font-display text-4xl uppercase mb-2">
        {isAdmin ? 'admin' : 'moderator'} manual
      </h1>
      <p className="font-body text-sm text-off-white/55 mb-8">
        Operational reference for {isAdmin ? 'admin and moderator' : 'moderator'} staff.
        {isAdmin &&
          ' Admins have full access to everything moderators can do, plus sensitive donor data and destructive operations.'}
      </p>

      {/* ── LOGGING IN ─────────────────────────────────────────── */}
      <Section title="logging in">
        {isAdmin ? (
          <>
            <p>Two paths grant admin access:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <Term>Admin API key</Term> — enter the raw value of <Code>ADMIN_API_KEY</Code> at
                the login gate. The key is stored in <Code>localStorage</Code> for the session; use{' '}
                <Term>logout</Term> in the sidebar footer to clear it.
              </li>
              <li>
                <Term>Donor SSO session with ADMIN role</Term> — sign in via{' '}
                <a href="/wallet" className="text-d-yellow hover:underline">
                  your wallet
                </a>{' '}
                (Google or Discord only; your email must be email-verified and listed in{' '}
                <Code>ADMIN_EMAILS</Code>).
              </li>
            </ul>
          </>
        ) : (
          <>
            <p>Three paths grant moderator access:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <Term>Admin API key</Term> — enter <Code>key_admin_&lt;ADMIN_API_KEY&gt;</Code>{' '}
                value at the login gate (admin supersedes moderator).
              </li>
              <li>
                <Term>Moderator key</Term> — enter the raw value of <Code>MODERATOR_API_KEY</Code>.
                Stored in <Code>localStorage</Code>; use the <Term>logout</Term> button in the
                sidebar footer to clear it.
              </li>
              <li>
                <Term>Donor SSO session with MODERATOR role</Term> — sign in via{' '}
                <a href="/wallet" className="text-d-yellow hover:underline">
                  your wallet
                </a>{' '}
                (Google or Discord only; your email must be email-verified and listed in{' '}
                <Code>MODERATOR_EMAILS</Code> or <Code>ADMIN_EMAILS</Code>).
              </li>
            </ul>
            <p className="text-off-white/40 text-xs">
              Note: Twitch login does not set email-verified status and will not grant a role from
              the allowlist.
            </p>
          </>
        )}
      </Section>

      <Section title="money, Pools and credits">
        <p>
          <Term>Pledge amount</Term> sets three independent Pools: rewards, polls and goals.{' '}
          <Term>Money</Term> is new donation cash only, not shipping, Wallet funding, prices or
          allocations. Incentive amounts are not money: one dollar can count once in rewards, once
          in polls and once in goals. Never add the categories together.
        </p>
        <p>
          <Term>Wallet credit</Term> is available or held. A Pending pledge holds Wallet credit
          until payment or non-payment is verified. Signing out or passing the deadline does not
          release it. <Term>Pool credit</Term> is category-specific credit in one Event after an
          allocation is reversed. It cannot buy physical rewards.
        </p>
        <p>
          <Term>Unused pool money</Term> is unallocated poll or goal Pool budget, not donor credit.
          Staff assign the whole available category amount, with a server preview. Undo is available
          only while the target remains open; an admin can use the ordinary reversal otherwise.
        </p>
        <p>
          <Term>Default goal list</Term> is an ordered list of own-Channel or shared goals. The
          first open entry receives goal-Pool money. With no eligible entry, automatic fallback
          checks eligible primary-Channel list entries, then the closest own goal, then the closest
          shared goal. The Channel editor names the current recipient; fulfillment checks again.
        </p>
        <p>
          <Term>Event end</Term> is distinct from deactivation. Only admins can End an inactive
          Event or Undo end, after preview and slug confirmation. End makes poll/goal credit Unused
          and expires reward credit. Undo is blocked by consuming moderator assignments. An ended
          Event cannot be reactivated before Undo.
        </p>
      </Section>

      {/* ── DASHBOARD ──────────────────────────────────────────── */}
      <Section title="dashboard">
        <p>
          The dashboard gives a live count of key objects.{' '}
          {isAdmin
            ? 'Admin dashboard separates Money, Needs attention and Credits, with independent money and incentive tables by Channel. Money totals count COMPLETED and REFUNDED donations, not CHARGEBACK. Payment refund recovery also lists failed shipping after item resolution.'
            : 'Moderator dashboard shows pending custom entries, active incentives and Unused pool money, with separate poll and goal amounts.'}
        </p>
        <p>
          Use the dashboard as a quick health check at the start of each session. A non-zero{' '}
          <Term>pending custom entries</Term> count means write-ins are waiting for approval — visit{' '}
          <Term>Polls</Term> to action them.
        </p>
      </Section>

      {/* ── EVENTS & CHANNELS ──────────────────────────────────── */}
      <Section title="events & channels">
        <p>
          An <Term>event</Term> is a charity event (a marathon, or a one-day stream event) that
          groups channels (streams). A <Term>channel</Term> represents a single donation target
          inside an event. Every donation is routed to exactly one channel, and so to exactly one
          event. Incentives can be <Term>shared</Term> (available in every channel) or scoped to one
          channel.
        </p>
        <p>Key operations on an event:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>Create</Term> — give the event a name. The <Term>slug</Term> is derived from the
            name unless you supply one.
          </li>
          <li>
            <Term>Primary channel</Term> — donations that name no channel are routed here. It must
            be an active channel of this event before the event can be activated.
          </li>
          <li>
            <Term>Activate / deactivate</Term> — only active events are open for donations. The slug
            of an active event is blocked from changing: changing a slug breaks overlay bindings and
            published links, so it is blocked while active.
          </li>
          <li>
            <Term>Delete</Term> — soft-deletes (sets <Code>is_active: false</Code>). Existing
            donations are not affected.
          </li>
        </ul>
        <p>Key operations on a channel:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>Create</Term> — give the channel a name, choose its event, and set it active. The
            slug is derived from the name unless you supply one.
          </li>
          <li>
            <Term>Edit</Term> — rename or toggle <Code>is_active</Code>. A channel's slug is blocked
            from changing while the channel is active, for the same reason as an event's. Active
            channels appear in the public donation picker.
          </li>
          <li>
            <Term>Delete</Term> — soft-deletes (sets <Code>is_active: false</Code>). Existing
            donations are not affected.
          </li>
        </ul>
        <p>
          Deep links: an event is shareable at <Code>/donate/&lt;event-slug&gt;</Code>, and a single
          channel at <Code>/donate/&lt;event-slug&gt;/&lt;channel-slug&gt;</Code>. A link to an
          event with exactly one channel selects that channel; otherwise the event's primary channel
          is selected.
        </p>
        {isAdmin && (
          <p>
            <Term>Unassigned donations</Term> — a donation that named no channel, when no single
            event was active or its event had no primary channel, is recorded with no channel and no
            event. The donations list has an <Term>unassigned only</Term> filter and an{' '}
            <Code>assign…</Code> control on those rows; assigning a channel publishes the donation
            to that channel's event. Unassigned donations do not reach overlays until they are
            assigned.
          </p>
        )}
      </Section>

      {/* ── REWARDS ────────────────────────────────────────────── */}
      <Section title="rewards">
        <p>
          <Term>Rewards</Term> are fixed-price items selected within the reward Pool. Each reward
          has one of four types:
        </p>
        <Table
          headers={['type', 'notes']}
          rows={[
            ['digital', 'Delivered electronically. No shipping collected.'],
            [
              'physical',
              'Shipped item. Stripe collects shipping address. A shipping rate may be charged if STRIPE_SHIPPING_RATE_ID is set.',
            ],
            ['shoutout', 'Optional donor message attached. No shipping.'],
            ['custom', 'Anything else; label describes it.'],
          ]}
        />
        <p>Fields when creating/editing a reward:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>name</Term> / <Term>description</Term> — displayed to donors.
          </li>
          <li>
            <Term>cost_cents</Term> — price in integer cents (e.g. <Code>1000</Code> = $10.00).
          </li>
          <li>
            <Term>quantity</Term> — leave blank for unlimited. Once stock reaches zero, donors
            cannot select it for a new pledge.
          </li>
          <li>
            <Term>is_active</Term> — inactive rewards are hidden from donors but not deleted.
          </li>
          <li>
            <Term>channel</Term> — assign to a channel to scope it, or leave blank for shared.
          </li>
          <li>
            <Term>image</Term> — upload a WebP image (auto-resized to ≤800 px, ~80% quality).
          </li>
        </ul>
        {isAdmin && (
          <p>
            <Term>Delete</Term> is blocked if any claims exist for the reward. Use{' '}
            <Term>deactivate</Term> (<Code>is_active: false</Code>) instead of deleting a reward
            with claims.
          </p>
        )}
      </Section>

      {/* ── POLLS ──────────────────────────────────────────────── */}
      <Section title="polls">
        <p>
          <Term>Polls</Term> receive allocations toward options, including donor, auto and moderator
          sources. Pool allocations may be positive cents below $1. A poll can optionally allow{' '}
          <Term>custom write-ins</Term>.
        </p>
        <p>Managing poll options:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>Add option</Term> — append a new votable option to an open poll.
          </li>
          <li>
            <Term>Rename option</Term> — edit the option label. Existing votes are unaffected.
          </li>
          <li>
            <Term>Remove option</Term> — moderators can remove only unused setup records; any live
            or reversed allocation history is protected. Admin removal reverses allocations and
            deactivates the option, preserving history.
          </li>
          {isAdmin && (
            <li>
              <Term>Reverse votes</Term> — preview each credit destination before confirming.
              Donor/auto Pool funding returns category Pool credit, moderator funding returns Unused
              pool money, legacy funding returns recorded Wallet credit. Credit redemptions restore
              their original grants. Ended-Event reward credit is expired.
            </li>
          )}
        </ul>
        <p>Custom write-in approval workflow:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Donor submits a write-in. It enters a <Term>pending</Term> queue.
          </li>
          <li>
            <Term>Approve</Term> — activates the option and credits existing write-in votes to its
            tally.
          </li>
          <li>
            <Term>Reject</Term> — reverses each funding row through its original credit policy; it
            does not promise Wallet credit.
          </li>
        </ul>
        <p>
          The moderator dashboard shows a badge for pending write-ins. Action them promptly so
          donors' funds are not left in limbo.
        </p>
      </Section>

      {/* ── FUND GOALS ─────────────────────────────────────────── */}
      <Section title="fund goals">
        <p>
          <Term>Fund goals</Term> show allocated progress, not money raised. A goal completes when
          allocated progress reaches its target. Completion is derived; deactivate to close early.
          Ordinary reversals and Wallet refunds recompute completion. Chargebacks and Payment-refund
          shrink preserve completed flags.
        </p>
        <p>Fields when creating/editing a goal:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>name</Term> / <Term>description</Term>.
          </li>
          <li>
            <Term>target_cents</Term> — target amount in integer cents.
          </li>
          <li>
            <Term>is_active</Term> — inactive goals are hidden from donors.
          </li>
          <li>
            <Term>channel</Term> — optional scoping.
          </li>
        </ul>
        {isAdmin && (
          <p>
            <Term>Admin remove</Term> reverses contributions and deactivates, preserving history and
            using the server's destination preview. <Term>Moderator delete</Term> removes only
            records without allocation history (including reversed history). Goals referenced by a
            Default goal list must first be removed from the list.
          </p>
        )}
        {isAdmin && (
          <p>
            <Term>Reverse contributions</Term> uses recorded amounts and funding sources, not a
            generic Wallet grant. Titles and option labels are trimmed and nonempty. Prices and
            targets are positive representable integer cents; stock is nonnegative or unlimited.
            Channel/reward-type changes are blocked by any allocation history.
          </p>
        )}
      </Section>

      {/* ── AUCTIONS ───────────────────────────────────────────── */}
      <Section title="auctions">
        <p>
          <Term>Auctions</Term> accept monetary offers from donors. The donor with the highest offer
          at close wins. An auction moves through a fixed lifecycle:
        </p>
        <Table
          headers={['state', 'meaning']}
          rows={[
            ['OPEN', 'Accepting bids/offers from donors.'],
            ['CLOSED', 'Winner selected; offer fulfillment in progress.'],
            ['CANCELLED', 'All bidders refunded; no winner.'],
          ]}
        />
        <p>Lifecycle actions available from the auctions page:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>Close</Term> — ends the auction and selects the winning (highest) offer. The
            winner receives a fulfillment email.
          </li>
          <li>
            <Term>Cancel</Term> — cancels the auction and refunds all bidders.
          </li>
          <li>
            <Term>Reopen</Term> — moves a closed or cancelled auction back to OPEN.
          </li>
          <li>
            <Term>Skip offer</Term> — skips the current top offer and advances to the next, useful
            if the winner is unresponsive.
          </li>
          <li>
            <Term>Resend offer email</Term> — re-sends the fulfillment email to the current offer
            holder.
          </li>
        </ul>
        <p>
          The <Term>offers</Term> view shows all offers ranked by amount.{' '}
          {isAdmin
            ? 'Admin view includes donor email.'
            : 'Moderator view shows donor ID only — not email.'}
        </p>
        <p>
          Fields when creating an auction: <Term>name</Term>, <Term>description</Term>,{' '}
          <Term>minimum_bid_cents</Term>, <Term>buy_now_cents</Term> (optional instant-win price),
          and <Term>ends_at</Term> deadline. Pricing and deadline can only be edited while the
          auction is OPEN.
        </p>
      </Section>

      {/* ── CLAIMS ─────────────────────────────────────────────── */}
      <Section title="claims">
        <p>
          A <Term>claim</Term> is created when a donor's pledge is fulfilled and it contained a
          reward. Claims track fulfillment status.
        </p>
        <Table
          headers={['status', 'meaning']}
          rows={[
            ['PENDING', 'Reward has been claimed; not yet shipped/delivered.'],
            ['FULFILLED', 'Reward has been delivered or shipped.'],
            ['CANCELLING', 'A Payment refund is requested; mutations are locked.'],
            ['REVERSED', 'Historical claim; cannot be resurrected.'],
          ]}
        />
        <p>
          {isAdmin
            ? 'Only live PENDING ↔ FULFILLED transitions are allowed. A chargeback or REQUESTED Payment refund in any funding source blocks both directions. Shipped claims retained by chargeback have an acknowledgement action, not a reversal. Claims show recorded allocation and current catalog price separately.'
            : 'The moderator claims view is read-only and live-only. Names come from the claim’s own donation, even if that name is empty; only unlinked claims fall back to the donor’s newest donation.'}
        </p>
        {isAdmin && (
          <p>
            Admin claims list includes <Term>donor email</Term> and the full <Term>claim_data</Term>{' '}
            JSON (which contains shoutout messages, custom entries, etc.). Moderator view omits
            email.
          </p>
        )}
      </Section>

      {/* ── DONATIONS ──────────────────────────────────────────── */}
      <Section title="donations">
        <p>
          The donations list shows donations of every status, with a status filter. Each row
          includes the amount, channel, timestamp, and donor name.{' '}
          {isAdmin
            ? 'Admin view also includes donor email.'
            : 'Moderator view never shows donor email (privacy invariant).'}
        </p>
        <p>
          <Term>Moderation flag</Term> — toggle the <Code>moderated</Code> flag on any donation to
          record that a human has reviewed it. It is sent only to native-format destinations that
          subscribe to it; overlays never see it. It does <em>not</em> block or hide the donation.
        </p>
        <p>
          <Term>Hide from overlay</Term> — removes the donation from the stream overlay (it is
          re-sent as "Anonymous" with no message). The donation still counts toward totals.
          Un-hiding re-adds it and plays the alert again.
        </p>
        {isAdmin && (
          <p>
            <Term>Wallet refund</Term> and <Term>Record chargeback</Term> are whole-donation actions
            on the detail page, with server previews. REFUNDED and CHARGEBACK are terminal;
            REQUESTED Payment refunds block them. Zero-money donations cannot be charged back. There
            are no manual PENDING/COMPLETED transitions. Wallet refunds keep charity money;
            chargebacks remove it from counted totals. Fulfilled claims stay allocated. Never sum
            overlapping Pools to calculate a Wallet grant.
          </p>
        )}
        {isAdmin && (
          <p>
            Admin donation and donor views contain private donor email alongside donation history.
            Do not share these views with moderator-level staff.
          </p>
        )}
      </Section>

      {/* ── PLEDGES (ADMIN ONLY) ────────────────────────────────── */}
      {isAdmin && (
        <Section title="pledges">
          <p>
            A <Term>Pending pledge</Term> is an immutable confirmed pledge sent to checkout. Draft
            pledges stay in the browser. It records the pledge amount, held Wallet funding, new cash
            due and confirmed item prices. Pledges are created by <Code>POST /api/pledge</Code> and
            fulfilled automatically when Stripe reports a successful payment.
          </p>
          <p>
            The paginated pledges list defaults OPEN, with status and overdue filters. Shipping is
            separate and may be unknown before Stripe completes checkout. Statuses:
          </p>
          <Table
            headers={['status', 'meaning']}
            rows={[
              ['OPEN', 'Awaiting payment or fulfillment.'],
              ['FULFILLED', 'Payment received and all items processed.'],
              ['EXPIRED / CANCELLED', 'Local state, not proof of non-payment. Check Stripe.'],
              [
                'LEGACY_PAID (payment state; status EXPIRED)',
                'Paid after transition: not fulfilled. Cash-only legacy Wallet receipt. Original historical FULFILLED pledges stay fulfilled.',
              ],
              [
                'PAYMENT_REVIEW',
                'Cash-only recovery requiring admin review, not original fulfillment.',
              ],
            ]}
          />
          <p>
            Use Check Stripe to reconcile the original Session. PROCESSING or UNKNOWN keeps funding
            held. Only authoritative non-payment releases holds. Do not simulate money or manually
            release funding to repair checkout.
          </p>
        </Section>
      )}

      {/* ── DONORS (ADMIN ONLY) ─────────────────────────────────── */}
      {isAdmin && (
        <Section title="donors">
          <p>
            The donors list is paginated (50 per page) and supports email search. Clicking a donor
            opens their full detail view.
          </p>
          <p>Actions available on a donor:</p>
          <Table
            headers={['action', 'effect']}
            rows={[
              ['Set role', 'Assign USER, MODERATOR, or ADMIN. Never granted by donating.'],
              [
                'Revoke token',
                'Invalidates the magic token; donor cannot access wallet until a new link is issued.',
              ],
              [
                'Regenerate token',
                'Issues a new magic token with a fresh TTL. Use to send a new magic link.',
              ],
              [
                'Freeze / unfreeze',
                'Blocks the donor from spending or signing in. Use during dispute processing.',
              ],
              [
                'Adjust Wallet credit',
                'Adjust available Wallet credit with an audit reason. Held Wallet and per-category Pool credit are not manual adjustment targets. REFUND (old) is historical item-reversal vocabulary.',
              ],
              [
                'Reverse spend',
                'Preview the recorded allocation’s actual destination: category Pool credit, original grants, Unused pool money or legacy Wallet credit. Fulfilled/terminal/REQUESTED locks apply.',
              ],
            ]}
          />
          <p>
            <Term>Important</Term>: roles are never granted as a side effect of donating. Use{' '}
            <Code>ADMIN_EMAILS</Code> / <Code>MODERATOR_EMAILS</Code> env vars for persistent
            allowlists, or set the role explicitly here for one-off grants.
          </p>
        </Section>
      )}

      {/* ── BLOCKED WORDS (ADMIN ONLY) ──────────────────────────── */}
      {isAdmin && (
        <Section title="blocked words">
          <p>
            The blocked-words list filters donor-submitted text (poll write-ins, pledge comments,
            donor names). Adding a word causes any submission containing it to be rejected with a
            validation error.
          </p>
          <p>
            Add words conservatively — overly broad entries block legitimate content. Words are
            matched case-insensitively.
          </p>
        </Section>
      )}

      {/* ── DESTINATIONS (ADMIN ONLY) ───────────────────────────── */}
      {isAdmin && (
        <Section title="destinations (webhooks & rabbitmq)">
          <p>
            <Term>Destinations</Term> are where webhook messages are sent. Every significant
            platform change (donation created, moderated, hidden or shown again; incentive created,
            enabled, disabled or changed) is sent, in order, to every active native-format
            destination subscribed to it. A Tiltify-compatible destination instead gets donations
            and totals only; kollekt and esa-layouts-v2 read incentives from the Tiltify-compatible
            API at <Code>/api/tiltify/</Code>.
          </p>
          <Table
            headers={['type', 'notes']}
            rows={[
              [
                'HTTP',
                'POST JSON payload to a URL. Payload is HMAC-signed with the destination secret.',
              ],
              [
                'RABBITMQ',
                'Publish to a RabbitMQ exchange. Useful for overlay/automation pipelines.',
              ],
            ]}
          />
          <p>Managing destinations:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <Term>Payload format</Term> — <Term>Native</Term> is our envelope, for our own tools.{' '}
              <Term>Tiltify-compatible</Term> is RabbitMQ only, for kollekt and esa-layouts-v2.
            </li>
            <li>
              <Term>Create</Term> — provide a URL (HTTP) or exchange config (RABBITMQ). A signing
              secret is auto-generated if not supplied.
            </li>
            <li>
              <Term>Rotate secret</Term> — generates a new HMAC signing secret. Update any consumers
              before rotating to avoid a delivery gap.
            </li>
            <li>
              <Term>Delivery log</Term> — recent deliveries for a destination (status, attempts,
              next attempt, last error). Successful rows are kept 2 hours, failed rows 24 hours;
              waiting rows are never removed.
            </li>
            <li>
              <Term>Test ping</Term> — queues a <Code>ping</Code> delivery to verify connectivity.
            </li>
            <li>
              <Term>Stalls</Term> — If a destination is down or answers with an error (including 4xx
              such as 429), its messages wait and are retried forever, every few seconds up to every
              3 minutes, in order. Nothing is skipped. Fix the destination and delivery resumes by
              itself. Set it inactive to pause it.
            </li>
            <li>
              <Term>Requeue</Term> — A delivery shows FAILED only when the message itself was
              malformed (a bug). After the fix, use requeue on the row or requeue all failed; it is
              re-sent at its original position.
            </li>
          </ul>
        </Section>
      )}

      {/* ── SIMULATE DONATION (ADMIN ONLY) ─────────────────────── */}
      {isAdmin && (
        <Section title="simulate donation">
          <p>
            The simulate page injects a fake donation without real money or Stripe. Use it during
            testing, onboarding, or to manually credit a donor outside the normal flow.
          </p>
          <p>
            Fields: <Term>donor email</Term>, <Term>amount</Term>, optional <Term>donor name</Term>,{' '}
            <Term>channel</Term> and <Term>comment</Term>. To record a real donation received
            outside Stripe, also set the <Term>external reference</Term> (the other platform's
            transaction id; must be unique) and the <Term>date received</Term>.
          </p>
          <p>
            The response includes a <Term>magic link</Term>. Share it with the donor (or open it
            yourself) to access the resulting wallet and verify the outcome.
          </p>
          <p>
            Simulated donations are indistinguishable from real ones in the database. Do not
            simulate donations on production data unless intentionally crediting a donor.
          </p>
        </Section>
      )}

      {/* ── COMMON WORKFLOWS ───────────────────────────────────── */}
      <Section title="common workflows">
        <p>
          <Term>Approving a custom poll write-in</Term>
        </p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Navigate to Polls → find the poll with pending entries.</li>
          <li>Open the custom entries queue (shown inline or via the entry count badge).</li>
          <li>
            Review the submitted text against the blocked-words policy and content guidelines.
          </li>
          <li>Click Approve to activate the option, or Reject to refund the donor.</li>
        </ol>

        <p className="pt-2">
          <Term>Fulfilling a reward claim</Term>
        </p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Navigate to Claims.</li>
          <li>Locate the PENDING claim (filter by reward name if needed).</li>
          <li>Deliver the reward (ship item, send code, give shoutout).</li>
          <li>Toggle the status to FULFILLED.</li>
        </ol>

        {isAdmin && (
          <>
            <p className="pt-2">
              <Term>Payment refunds for physical cancellations</Term>
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                Open the donation detail → rewards Pool rows. Cancel with Payment refund is
                available only for eligible direct PENDING physical claims on a COMPLETED pooled
                Stripe donation before its Event ends.
              </li>
              <li>
                Review the server item/shipping return, cash and pledge amount before/after, all
                category shrink and affected ended/completed targets. Physical credit-funded or
                already-shipped claims are ineligible. Wallet funding is unchanged.
              </li>
              <li>
                Confirm once. REQUESTED locks mutations; Retry / Check Stripe discovers an existing
                refund before any same-key retry. PENDING / REQUIRES_ACTION is accepted but not
                settled.
              </li>
              <li>
                A later FAILED refund needs explicit item recovery: returned outside the app, Wallet
                credit (COMPLETED/REFUNDED only), or dispute (CHARGEBACK only). Allocations stay
                shrunk. Shipping is resolved independently as returned outside the app or kept by
                agreement; it never becomes Wallet credit or donation money.
              </li>
              <li>
                The default open Payment refunds list keeps unresolved failed shipping visible after
                item resolution. Sweep credits on the donor page affects available Wallet credit
                only, never holds or Pool credit.
              </li>
            </ol>

            <p className="pt-2">
              <Term>Handling a GDPR / data deletion request</Term>
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Navigate to Donors → search by email.</li>
              <li>
                <Term>Freeze</Term> the account to prevent further activity while processing.
              </li>
              <li>
                <Term>Revoke token</Term> to block wallet access immediately.
              </li>
              <li>
                Export/review their data from the donor detail page (donations, claims, votes,
                contributions).
              </li>
              <li>
                Contact your data controller/DPO to action deletion in the database if required. The
                UI does not have a hard-delete donor option — this must be done at the database
                level.
              </li>
            </ol>
          </>
        )}
      </Section>

      {/* ── PRIVACY INVARIANTS ─────────────────────────────────── */}
      <Section title="privacy invariants">
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>Moderators never see donor email addresses.</Term> Only admins can access email
            via the admin donations list or donor detail pages.
          </li>
          <li>
            Donor roles are <em>never</em> granted as a side effect of donating — a self-supplied
            Stripe checkout email cannot buy moderator or admin access.
          </li>
          <li>
            The <Code>ADMIN_EMAILS</Code>/<Code>MODERATOR_EMAILS</Code> allowlists only apply after
            the email has been verified via Google or Discord OAuth. Twitch logins are never
            allowlisted.
          </li>
          {isAdmin && (
            <li>
              Admin donation and donor views contain private email. Treat them as sensitive; shared
              services and moderator responses never add donor email.
            </li>
          )}
        </ul>
      </Section>
    </div>
  );
}
