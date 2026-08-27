import Card from '../components/Card';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mb-6">
      <h2 className="font-display text-3xl uppercase text-off-white mb-3">{title}</h2>
      <div className="space-y-3 font-body text-sm text-off-white/55">{children}</div>
    </Card>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <strong className="text-off-white">{children}</strong>;
}

export default function Help() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="font-display text-4xl uppercase mb-6">help</h1>

      <Section title="incentive types & categories">
        <p>
          The contribute flow is organized into three categories: <Term>rewards</Term>,{' '}
          <Term>polls</Term>, and <Term>fund goals</Term>.
        </p>
        <p>
          <Term>Rewards</Term> are fixed-cost items you add to your cart. Each has one of four
          types:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <Term>digital</Term> — delivered electronically (a code, art, etc.); no shipping.
          </li>
          <li>
            <Term>physical</Term> — a shipped item; shipping is arranged through Stripe, and this
            platform never collects or stores your shipping address.
          </li>
          <li>
            <Term>shoutout</Term> — a shoutout, with an optional message you can attach.
          </li>
          <li>
            <Term>custom</Term> — anything else, described by its own label.
          </li>
        </ul>
        <p>Rewards may have a limited quantity and can sell out.</p>
        <p>
          <Term>Polls</Term> let you fund a vote toward an option you support (minimum $1.00). Some
          polls also allow a <Term>custom write-in</Term> option, funded the same way; write-ins are
          either approved automatically or held for moderator review.
        </p>
        <p>
          <Term>Fund goals</Term> are pooled targets. You contribute any amount (minimum $1.00)
          toward a goal, which completes once fully funded.
        </p>
        <p>
          Every donation is routed to exactly one <Term>channel</Term>. An incentive is either
          shared (available for any channel) or tied to a specific channel, and you can't mix
          incentives from two channels in a single cart.
        </p>
      </Section>

      <Section title="wallet & payments">
        <p>
          There are no accounts or passwords. Your wallet is identified by email and unlocked with
          the magic link emailed after each donation. You can also sign in with Google, Discord, or
          Twitch.
        </p>
        <p>
          Every donation credits your wallet balance (the donation amount, minus any shipping cost).
          You spend that balance on rewards, polls, and goals.
        </p>
        <p>
          At checkout, your wallet balance automatically offsets the <Term>incentive items</Term> in
          your cart. The <Term>additional contribution</Term> you add on top is always charged as
          real money and is never covered by your balance.
        </p>
        <p>
          If your wallet balance covers the entire cart and there is no additional contribution,
          your pledge is fulfilled immediately — no payment is taken.
        </p>
        <p>
          The one exception is <Term>physical rewards</Term>: those always go through Stripe
          checkout to handle shipping (and any shipping fee), even when your balance covers the item
          cost.
        </p>
        <p>
          Payments are handled by Stripe's hosted checkout, so your card details never touch this
          platform.
        </p>
      </Section>

      <Section title="refunds">
        <p>
          Refunds are returned to your <Term>wallet balance</Term>, not automatically to your card.
          An admin can reverse a reward claim, poll vote, or goal contribution, restoring the funds
          to your balance.
        </p>
        <p>
          Funds are also returned to your balance automatically when a poll option or goal you
          contributed to is removed, or when a custom write-in is rejected.
        </p>
        <p>
          To request a refund, or a return of funds to your payment card, contact the event
          organizers by email.
        </p>
      </Section>

      <Section title="physical items">
        <p>
          Physical rewards are shipped items. Shipping is arranged through Stripe's checkout; this
          platform does not collect or store your shipping address.
        </p>
        <p>
          After your pledge is fulfilled, the claim appears in your wallet as <Term>pending</Term>.
          The team ships the item and marks it <Term>fulfilled</Term> once it's on its way.
        </p>
      </Section>

      <Section title="your data (gdpr)">
        <p>
          This platform stores only what it needs to route your donation: your email address, an
          optional donor name, and any comment or write-in you submit. It never collects or stores
          your shipping address. There are no passwords. Card details are held by Stripe, never by
          this platform.
        </p>
        <p>
          Moderators never see your email address — only admins can. To request access to,
          correction of, or deletion of your personal data, contact the event organizers by email.
          An admin can freeze your account (blocking spending and sign-in) or revoke its access
          token while a request is processed.
        </p>
      </Section>
    </div>
  );
}
