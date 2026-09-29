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

      {/* ── DASHBOARD ──────────────────────────────────────────── */}
      <Section title="dashboard">
        <p>
          The dashboard gives a live count of key objects.{' '}
          {isAdmin
            ? 'Admin dashboard shows total raised (in cents), donors, donations, claims, pledges, and a per-channel raised/count breakdown.'
            : 'Moderator dashboard shows pending custom poll entries, active polls, active rewards, and active goals.'}
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
          event. Incentives can be <Term>shared</Term> (available in any event/channel) or scoped to
          a specific event or channel.
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
            <Term>Unassigned donations</Term> — a donation that arrived while no single event was
            active is recorded with no channel and no event. The donations list has an{' '}
            <Term>unassigned only</Term> filter and an <Code>assign…</Code> control on those rows;
            assigning a channel publishes the donation to that channel's event. Unassigned donations
            do not reach overlays until they are assigned.
          </p>
        )}
      </Section>

      {/* ── REWARDS ────────────────────────────────────────────── */}
      <Section title="rewards">
        <p>
          <Term>Rewards</Term> are fixed-cost items donors add to their cart. Each reward has one of
          four types:
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
            cannot add it to the cart.
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
          <Term>Polls</Term> allow donors to fund a vote toward an option. Votes have a minimum of
          $1.00. A poll can optionally allow <Term>custom write-ins</Term>.
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
            <Term>Delete option</Term> — removes the option and <Term>refunds</Term> all vote
            balances to donors.
          </li>
          {isAdmin && (
            <li>
              <Term>Refund option (without delete)</Term> — returns all votes on an option to donor
              balances while leaving the option visible.
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
            <Term>Reject</Term> — refunds the donor's balance and removes the entry.
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
          <Term>Fund goals</Term> are pooled funding targets. Donors contribute any amount (minimum
          $1.00). A goal completes once the target is reached.
        </p>
        <p>Fields when creating/editing a goal:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>name</Term> / <Term>description</Term>.
          </li>
          <li>
            <Term>goal_cents</Term> — target amount in integer cents.
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
            <Term>Admin delete</Term> deactivates the goal <em>and refunds all contributions</em> to
            donor balances. <Term>Moderator delete</Term> is a hard-delete with no refund logic —
            only use it on goals with no contributions.
          </p>
        )}
        {isAdmin && (
          <p>
            <Term>Refund goal (without delete)</Term> — returns all contributions to donor balances
            while the goal record remains.
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
          ]}
        />
        <p>
          Toggle a claim's status using the status button on the claims page. For physical rewards,
          mark <Term>FULFILLED</Term> once the item has been dispatched. For digital rewards, mark
          fulfilled once the code or file has been sent.
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
          The donations list shows all completed donations. Each row includes the amount, channel,
          timestamp, and donor name.{' '}
          {isAdmin
            ? 'Admin view also includes donor email.'
            : 'Moderator view never shows donor email (privacy invariant).'}
        </p>
        <p>
          <Term>Moderation flag</Term> — toggle the <Code>moderated</Code> flag on any donation to
          record that a human has reviewed it. This flag is used by downstream tools (overlays,
          exports). It does <em>not</em> block or hide the donation.
        </p>
        <p>
          <Term>Hide from overlay</Term> — removes the donor's name and message from the stream
          overlay. The donation still counts toward totals. Un-hiding re-adds it and plays the alert
          again.
        </p>
        {isAdmin && (
          <p>
            The admin donations list is the only place in the UI where donor emails appear alongside
            donation records. Do not share this view with moderator-level staff.
          </p>
        )}
      </Section>

      {/* ── PLEDGES (ADMIN ONLY) ────────────────────────────────── */}
      {isAdmin && (
        <Section title="pledges">
          <p>
            A <Term>pledge</Term> is a cart a donor built before paying. It records the selected
            incentive items, total cost, and any comment. Pledges are created by{' '}
            <Code>POST /api/pledge</Code> and fulfilled automatically when Stripe reports a
            successful payment.
          </p>
          <p>The pledges list shows the last 100 pledges with their status and items. Statuses:</p>
          <Table
            headers={['status', 'meaning']}
            rows={[
              ['OPEN', 'Awaiting payment or fulfillment.'],
              ['FULFILLED', 'Payment received and all items processed.'],
              ['EXPIRED', 'Checkout session expired without payment.'],
            ]}
          />
          <p>
            If a pledge is OPEN long after expected fulfillment, check whether the Stripe webhook
            was received. A manual donation simulation can re-trigger fulfillment if needed.
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
                'Adjust balance',
                'Manually add or subtract balance with an audit reason (REFUND, FREEZE_ZERO, MANUAL, CHARGEBACK).',
              ],
              [
                'Reverse spend',
                "Undo a specific claim, vote, or contribution; atomically restores the donor's balance.",
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
            <Term>Destinations</Term> are outbound event delivery targets. Every significant
            platform change (donation created, donation moderated, incentive created, enabled,
            disabled or changed) is sent as a webhook message to every active destination subscribed
            to it, in order.
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
              such as 429), its messages wait and are retried every few seconds up to every 3
              minutes, in order. Nothing is skipped. Fix the destination and delivery resumes by
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
            Fields: <Term>donor email</Term>, <Term>amount</Term>, optional{' '}
            <Term>pledge token</Term> (links the donation to an existing pending pledge), optional{' '}
            <Term>channel</Term>, and optional <Term>comment</Term>.
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
              <Term>Issuing a refund to a donor</Term>
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Navigate to Donors → search by email → open donor detail.</li>
              <li>
                Use <Term>Reverse spend</Term> to undo a specific claim/vote/contribution (restores
                balance), or <Term>Adjust balance</Term> for a manual credit.
              </li>
              <li>
                If a card refund is needed, process it in the Stripe dashboard separately; this
                platform does not issue card refunds directly.
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
              The admin donations list (<Code>/admin/donations</Code>) is the only place in the
              system where donor email appears alongside donation records. Treat it as sensitive.
            </li>
          )}
        </ul>
      </Section>
    </div>
  );
}
