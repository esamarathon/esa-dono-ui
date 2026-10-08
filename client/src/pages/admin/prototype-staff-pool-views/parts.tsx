// THROWAWAY (#172): content blocks of the donation detail page (Q2). Each layout variant
// arranges them its own way; no page layout lives here.
import ChannelPill from '../../../components/ChannelPill';
import {
  CATEGORIES,
  liveRows,
  poolCredit,
  sumRows,
  unusedPool,
  type Category,
  type Donation,
  type PaymentRefundStatus,
} from './model';
import {
  ClaimTag,
  Money,
  NotMoneyNote,
  Num,
  Placeholder,
  POOL_TITLE,
  SourceTag,
  TH,
} from './shared';

export function Facts({ d, vertical = false }: { d: Donation; vertical?: boolean }) {
  const items = [
    {
      label: 'money',
      node: <Money cents={d.amountCents} big />,
      hint: 'new money (amount_cents)',
    },
    {
      label: 'pledge amount',
      node: d.pledge ? (
        <Num cents={d.pledge.pledgeCents} kind="pledge amount" big />
      ) : (
        <span className="font-display text-3xl text-off-white/40">—</span>
      ),
      hint: d.pledge ? 'sets the size of each Pool' : 'no pledge',
    },
    {
      label: 'Wallet credit applied',
      node: d.pledge ? (
        <Num cents={d.pledge.walletAppliedCents} kind="Wallet credit applied" big />
      ) : (
        <span className="font-display text-3xl text-off-white/40">—</span>
      ),
      hint: 'part of the pledge paid from the wallet',
    },
  ];
  return (
    <div className={vertical ? 'space-y-3' : 'grid grid-cols-1 sm:grid-cols-3 gap-3'}>
      {items.map((i) => (
        <div key={i.label} className="btrl-panel p-3">
          <p className="font-data text-sm text-off-white/60">{i.label}</p>
          {i.node}
          <p className="font-body text-xs text-off-white/45 mt-1">{i.hint}</p>
        </div>
      ))}
      <div className="sm:col-span-3">
        <NotMoneyNote />
      </div>
    </div>
  );
}

export function Identity({ d }: { d: Donation }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 font-body text-sm">
      <dt className="text-off-white/50">donor</dt>
      <dd>
        {d.donorName} · <span className="text-off-white/60">{d.email}</span>
      </dd>
      <dt className="text-off-white/50">event · channel</dt>
      <dd>
        {d.event}
        {d.eventEnded && <span className="text-off-white/50"> (ended)</span>} ·{' '}
        {d.channel ?? 'unassigned'}
      </dd>
      <dt className="text-off-white/50">received</dt>
      <dd>
        {d.createdAt.slice(0, 16).replace('T', ' ')} · {d.origin}
      </dd>
      {d.stripe && (
        <>
          <dt className="text-off-white/50">Stripe</dt>
          <dd className="font-mono text-xs break-all">{d.stripe}</dd>
        </>
      )}
      <dt className="text-off-white/50">comment</dt>
      <dd className="break-words">{d.comment ?? '—'}</dd>
    </dl>
  );
}

export function PoolBlock({ d, c }: { d: Donation; c: Category }) {
  if (!d.pledge) return null;
  const rows = liveRows(d, c);
  const credit = poolCredit(d, c);
  return (
    <div className="btrl-panel p-3 flex flex-col gap-2" data-testid={`pool-${c}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-xl uppercase">{POOL_TITLE[c]} Pool</h3>
        <span className="font-data text-sm text-off-white/60">
          Pool <Num cents={d.pledge.pledgeCents} kind="Pool size" />
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="font-body text-sm text-off-white/50">No live rows.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-body text-sm flex-1 min-w-[8rem]">{r.target}</span>
              <ChannelPill label={r.targetChannel} />
              <SourceTag source={r.source} by={r.allocatedBy} />
              {r.claim && <ClaimTag status={r.claim.status} flagged={r.claim.flagged} />}
              <Num cents={r.cents} kind="allocated" />
            </li>
          ))}
        </ul>
      )}
      <div
        className="mt-auto pt-2 space-y-1 font-data text-sm"
        style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
      >
        <p className="flex justify-between gap-2">
          <span className="text-off-white/60">allocated (live)</span>
          <Num cents={sumRows(rows)} kind="allocated" />
        </p>
        {credit > 0 && (
          <p className="flex justify-between gap-2">
            <span className="text-off-white/60">Pool credit</span>
            <Num cents={credit} kind="Pool credit" />
          </p>
        )}
        {c !== 'reward' && (
          <p className="flex justify-between gap-2">
            <span className="text-off-white/60">Unused pool money</span>
            <Num cents={unusedPool(d, c)} kind="Unused pool money" />
          </p>
        )}
      </div>
    </div>
  );
}

export function NoPools({ d }: { d: Donation }) {
  return (
    <p className="font-body text-sm text-off-white/55">
      No pledge ({d.origin}), so this donation has no Pools.
    </p>
  );
}

const PR_COLOR: Record<PaymentRefundStatus, string> = {
  REQUESTED: 'var(--d-yellow)',
  PENDING: 'var(--d-yellow)',
  REQUIRES_ACTION: 'var(--d-yellow)',
  SUCCEEDED: 'var(--green)',
  FAILED: 'var(--red)',
  RESOLVED: 'var(--off-white)',
};

export function PaymentRefunds({ d }: { d: Donation }) {
  return (
    <div className="space-y-3">
      {d.paymentRefunds.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No Payment refunds.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                {[
                  'status',
                  'item',
                  'item amount',
                  'shipping',
                  'Stripe Payment refund id',
                  'error',
                  'started',
                ].map((h) => (
                  <TH key={h}>{h}</TH>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.paymentRefunds.map((p) => (
                <tr key={p.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                  <td className="px-3 py-2">
                    <span
                      className="font-mono text-xs px-1.5 py-0.5 rounded-sm font-bold whitespace-nowrap"
                      style={{ background: 'rgba(239,238,236,.06)', color: PR_COLOR[p.status] }}
                    >
                      {p.status}
                      {p.status === 'FAILED' && !p.resolved ? ' · flagged' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-body">{p.item}</td>
                  <td className="px-3 py-2">
                    <Num cents={p.itemCents} kind="Payment refund item" />
                  </td>
                  <td className="px-3 py-2">
                    <Num cents={p.shippingCents} kind="shipping (outside every total)" />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{p.stripeRefundId ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-red max-w-[14rem] break-words">
                    {p.error ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-data text-off-white/60 whitespace-nowrap">
                    {p.createdBy} · {p.createdAt.slice(0, 16).replace('T', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Placeholder title="Payment refund actions on this page">
        <p>
          Decided in #167: who may start one, Retry for a REQUESTED record, and the resolutions of a
          FAILED one (Returned outside the app · Give as Wallet credit · Settled by the dispute).
        </p>
        <p>
          Not decided in #172: where the start action and these actions sit, and the global Payment
          refunds list.
        </p>
      </Placeholder>
    </div>
  );
}

export function EndedTargets({ d }: { d: Donation }) {
  if (d.endedTargetChanges.length === 0)
    return <p className="font-body text-sm text-off-white/55">No ended targets changed.</p>;
  return (
    <ul className="space-y-2">
      {d.endedTargetChanges.map((t) => (
        <li key={t.target} className="flex flex-wrap items-center gap-2 font-body text-sm">
          <span className="flex-1 min-w-[10rem]">{t.target}</span>
          <span className="font-mono text-xs text-off-white/60">{t.state}</span>
          <Num cents={t.deltaCents} kind="incentive total change" signedValue />
          <span className="font-mono text-xs text-off-white/45">{t.cause}</span>
        </li>
      ))}
    </ul>
  );
}

export function FlaggedClaims({ d }: { d: Donation }) {
  const flagged = d.rows.filter((r) => r.claim?.flagged);
  return (
    <div className="space-y-2">
      {flagged.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No flagged shipped claims.</p>
      ) : (
        <ul className="space-y-2">
          {flagged.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 font-body text-sm">
              <span className="flex-1">{r.target}</span>
              <ClaimTag status={r.claim!.status} flagged />
              <Num cents={r.cents} kind="recorded claim amount" />
            </li>
          ))}
        </ul>
      )}
      {flagged.length > 0 && (
        <Placeholder title="acknowledging a flagged shipped claim">
          <p>How an admin clears this flag has not been asked.</p>
        </Placeholder>
      )}
    </div>
  );
}

export function Q5Placeholder() {
  return (
    <Placeholder title="Q5: manual PENDING ↔ COMPLETED">
      <p>Open question. Not shown until decided.</p>
    </Placeholder>
  );
}

export function categoriesWithPools(d: Donation): Category[] {
  return d.pledge ? CATEGORIES : [];
}
