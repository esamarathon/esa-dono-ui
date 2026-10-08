// THROWAWAY (#172) variant C: a compact header that carries the key numbers and the actions,
// an attention banner, then tabs. Pools are a per-category summary table with expandable rows.
import { Fragment, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ChannelPill from '../../../components/ChannelPill';
import {
  ATTENTION_FLAGS,
  flags,
  liveRows,
  poolCredit,
  sumRows,
  unusedPool,
  type Category,
  type Donation,
  type StaffModel,
} from './model';
import {
  EndedTargets,
  FlaggedClaims,
  Identity,
  NoPools,
  PaymentRefunds,
  Q5Placeholder,
  categoriesWithPools,
} from './parts';
import {
  ClaimTag,
  FlagChip,
  Money,
  NotMoneyNote,
  Num,
  POOL_TITLE,
  SourceTag,
  StatusActions,
  StatusChip,
  TH,
} from './shared';

type Tab = 'pools' | 'payment refunds' | 'flags & ended targets' | 'details';

export default function DetailC({ m, d }: { m: StaffModel; d: Donation }) {
  const search = useLocation().search;
  const [tab, setTab] = useState<Tab>('pools');
  const [open, setOpen] = useState<Category | null>(null);
  const attention = flags(d).filter((f) => ATTENTION_FLAGS.includes(f));
  const tabs: Tab[] = ['pools', 'payment refunds', 'flags & ended targets', 'details'];
  const count: Partial<Record<Tab, number>> = {
    'payment refunds': d.paymentRefunds.length,
    'flags & ended targets':
      d.rows.filter((r) => r.claim?.flagged).length + d.endedTargetChanges.length,
  };

  return (
    <div className="max-w-6xl space-y-4">
      <Link to={`/admin/donations${search}`} className="font-mono text-sm text-off-white/55">
        ← donations
      </Link>
      <header className="btrl-panel p-4 flex flex-col lg:flex-row lg:items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-3xl uppercase">{d.donorName}</h1>
            <StatusChip status={d.status} />
            <span className="font-data text-off-white/60">
              {d.event} · {d.channel ?? 'unassigned'}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 font-data text-sm">
            <span>
              <span className="text-off-white/60">money </span>
              <Money cents={d.amountCents} />
            </span>
            <span>
              <span className="text-off-white/60">pledge amount </span>
              {d.pledge ? <Num cents={d.pledge.pledgeCents} kind="pledge amount" /> : '—'}
            </span>
            <span>
              <span className="text-off-white/60">Wallet credit applied </span>
              {d.pledge ? (
                <Num cents={d.pledge.walletAppliedCents} kind="Wallet credit applied" />
              ) : (
                '—'
              )}
            </span>
          </div>
        </div>
        <div className="lg:max-w-sm">
          <StatusActions m={m} d={d} compact />
        </div>
      </header>

      <NotMoneyNote />

      {attention.length > 0 && (
        <div
          role="alert"
          className="rounded-md p-3 flex flex-wrap items-center gap-2"
          style={{ background: 'rgba(252,28,103,.10)', border: '1px solid rgba(252,28,103,.4)' }}
        >
          <span className="font-display text-lg uppercase text-red">Needs attention</span>
          {attention.map((f) => (
            <button
              key={f}
              onClick={() =>
                setTab(
                  f === 'shipped claim after chargeback'
                    ? 'flags & ended targets'
                    : 'payment refunds',
                )
              }
            >
              <FlagChip flag={f} />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`font-data font-bold uppercase tracking-wider text-sm px-3 py-2 rounded-sm ${tab === t ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`}
            style={
              tab === t ? { background: 'var(--grad)' } : { background: 'rgba(239,238,236,.04)' }
            }
          >
            {t}
            {count[t] ? ` (${count[t]})` : ''}
          </button>
        ))}
      </div>

      {tab === 'pools' &&
        (d.pledge ? (
          <div className="space-y-2">
            <NotMoneyNote />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                    {[
                      'Pool',
                      'Pool size',
                      'allocated (live)',
                      'rows',
                      'Pool credit',
                      'Unused pool money',
                      '',
                    ].map((h) => (
                      <TH key={h}>{h}</TH>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categoriesWithPools(d).map((c) => {
                    const rows = liveRows(d, c);
                    const isOpen = open === c;
                    return (
                      <Fragment key={c}>
                        <tr
                          className="cursor-pointer hover:bg-[rgba(239,238,236,.04)]"
                          style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
                          onClick={() => setOpen(isOpen ? null : c)}
                        >
                          <td className="px-3 py-2 font-display text-lg uppercase">
                            {POOL_TITLE[c]}
                          </td>
                          <td className="px-3 py-2">
                            <Num cents={d.pledge!.pledgeCents} kind="Pool size" />
                          </td>
                          <td className="px-3 py-2">
                            <Num cents={sumRows(rows)} kind="allocated" />
                          </td>
                          <td className="px-3 py-2 font-data">
                            {rows.length}{' '}
                            <span className="text-off-white/50">
                              (
                              {['donor', 'auto', 'moderator']
                                .map((s) => [s, rows.filter((r) => r.source === s).length] as const)
                                .filter(([, n]) => n > 0)
                                .map(([s, n]) => `${n} ${s}`)
                                .join(', ') || 'none'}
                              )
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {poolCredit(d, c) > 0 ? (
                              <Num cents={poolCredit(d, c)} kind="Pool credit" />
                            ) : (
                              <span className="text-off-white/40">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {c === 'reward' ? (
                              <span
                                className="font-mono text-xs text-off-white/45"
                                title="Reward Pool money is never Unused pool money"
                              >
                                n/a
                              </span>
                            ) : (
                              <Num cents={unusedPool(d, c)} kind="Unused pool money" />
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-off-white/55">
                            {isOpen ? 'hide rows ▲' : 'show rows ▼'}
                          </td>
                        </tr>
                        {isOpen &&
                          rows.map((r) => (
                            <tr key={r.id} style={{ background: 'rgba(239,238,236,.025)' }}>
                              <td />
                              <td colSpan={3} className="px-3 py-1.5 font-body">
                                {r.target}
                              </td>
                              <td className="px-3 py-1.5">
                                <span className="inline-flex flex-wrap gap-1 items-center">
                                  <ChannelPill label={r.targetChannel} />
                                  <SourceTag source={r.source} by={r.allocatedBy} />
                                  {r.claim && (
                                    <ClaimTag status={r.claim.status} flagged={r.claim.flagged} />
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-1.5" colSpan={2}>
                                <Num cents={r.cents} kind="allocated" />
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <NoPools d={d} />
        ))}

      {tab === 'payment refunds' && <PaymentRefunds d={d} />}

      {tab === 'flags & ended targets' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h2 className="font-display text-xl uppercase mb-2">Flagged shipped claims</h2>
            <FlaggedClaims d={d} />
          </section>
          <section>
            <h2 className="font-display text-xl uppercase mb-2">
              Ended targets whose totals changed
            </h2>
            <EndedTargets d={d} />
          </section>
        </div>
      )}

      {tab === 'details' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="btrl-panel p-4">
            <Identity d={d} />
          </div>
          <Q5Placeholder />
        </div>
      )}
    </div>
  );
}
