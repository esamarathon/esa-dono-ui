// THROWAWAY (#172) variant C: a compact header that carries the key numbers and the actions,
// an attention banner, then tabs. Pools are a per-category summary table with expandable rows.
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import ChannelPill from '../../../components/ChannelPill';
import { InfoIcon } from '../../../components/icons';
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
} from './shared';

type Tab = 'pools' | 'payment refunds' | 'flags & ended targets' | 'details';

const COLUMN_HELP: Record<string, string> = {
  'Pool credit':
    'The donor can choose again in this category after an allocation was reversed or a write-in rejected. It can be spent on open incentives in the same Event, except physical rewards. It is not Wallet credit.',
  'Unused pool money':
    'Poll or goal Pool amount that is not allocated and is not Pool credit. A moderator can assign it to an eligible poll option or goal; the donor cannot spend it. Rewards do not have Unused pool money.',
};

// Same info affordance as InfoTip, but portalled so the table's horizontal scroller
// does not clip the explanation. Tap opens it; outside tap, Escape or scroll closes it.
function ColumnInfo({ label, text }: { label: string; text: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const width = Math.min(288, window.innerWidth - 32);
  const show = () => {
    const rect = button.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(
        16,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 16),
      ),
      top: rect.bottom + 8,
    });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [position]);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${label} explained`}
        aria-describedby={position ? id : undefined}
        aria-expanded={!!position}
        className="inline-flex align-middle ml-1 p-1 rounded-sm text-off-white/40 hover:text-off-white/80 focus-visible:outline focus-visible:outline-1"
        onPointerEnter={(event) => event.pointerType === 'mouse' && show()}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setPosition(null)}
        onFocus={() => button.current?.matches(':focus-visible') && show()}
        onBlur={() => setPosition(null)}
        onClick={show}
      >
        <InfoIcon className="h-3.5 w-3.5" />
      </button>
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="fixed z-[60] pointer-events-none rounded-sm border p-2.5 text-left font-body text-sm leading-snug shadow-lg"
            style={{
              ...position,
              width,
              background: 'var(--dark-gray)',
              borderColor: 'rgba(239,238,236,.12)',
              color: 'var(--off-white)',
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

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
      <header className="btrl-panel-dark p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-4xl uppercase">{d.donorName}</h1>
              <StatusChip status={d.status} />
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="font-body text-sm text-off-white/55">{d.event}</span>
              <ChannelPill label={d.channel ?? 'unassigned'} />
            </div>
          </div>
          <div className="max-w-sm">
            <StatusActions m={m} d={d} compact />
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 pt-4 border-t border-off-white/10">
          <div>
            <dt className="font-body text-sm text-off-white/55 min-h-[2.5rem] sm:min-h-0">Money</dt>
            <dd className="mt-1">
              <Money cents={d.amountCents} big />
            </dd>
          </div>
          <div>
            <dt className="font-body text-sm text-off-white/55 min-h-[2.5rem] sm:min-h-0">
              Pledge amount
            </dt>
            <dd className="mt-1">
              {d.pledge ? (
                <Num cents={d.pledge.pledgeCents} kind="pledge amount" big />
              ) : (
                <span className="font-display text-3xl text-off-white/40">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="font-body text-sm text-off-white/55 min-h-[2.5rem] sm:min-h-0">
              Wallet credit applied
            </dt>
            <dd className="mt-1">
              {d.pledge ? (
                <Num cents={d.pledge.walletAppliedCents} kind="Wallet credit applied" big />
              ) : (
                <span className="font-display text-3xl text-off-white/40">—</span>
              )}
            </dd>
          </div>
        </dl>
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

      <div className="flex flex-wrap gap-x-2 border-b border-off-white/10" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`font-data font-bold uppercase tracking-wider text-base px-3 py-3 border-b-2 -mb-px ${tab === t ? 'text-off-white border-purple' : 'text-off-white/50 border-transparent hover:text-off-white/80'}`}
          >
            {t}
            {count[t] ? ` (${count[t]})` : ''}
          </button>
        ))}
      </div>

      {tab === 'pools' &&
        (d.pledge ? (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-md border border-off-white/10 bg-dark-gray/60">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="bg-off-white/[.03]">
                    {[
                      'Pool',
                      'Pool size',
                      'allocated (live)',
                      'rows',
                      'Pool credit',
                      'Unused pool money',
                      '',
                    ].map((h) => (
                      <th
                        key={h}
                        className={`px-4 py-3 font-data font-bold text-sm tracking-wider uppercase text-off-white/50 whitespace-nowrap ${['Pool size', 'allocated (live)', 'Pool credit', 'Unused pool money'].includes(h) ? 'text-right' : 'text-left'}`}
                      >
                        {h}
                        {COLUMN_HELP[h] && <ColumnInfo label={h} text={COLUMN_HELP[h]} />}
                      </th>
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
                          className={`cursor-pointer border-t border-off-white/[.07] hover:bg-off-white/[.04] ${isOpen ? 'bg-purple/10' : ''}`}
                          onClick={() => setOpen(isOpen ? null : c)}
                        >
                          <td className="px-4 py-4 font-display text-xl uppercase">
                            {POOL_TITLE[c]}
                          </td>
                          <td className="px-4 py-4 text-right font-data text-base tabular-nums">
                            <Num cents={d.pledge!.pledgeCents} kind="Pool size" />
                          </td>
                          <td className="px-4 py-4 text-right font-data text-base tabular-nums">
                            <Num cents={sumRows(rows)} kind="allocated" />
                          </td>
                          <td className="px-4 py-4 font-data text-base text-off-white/60">
                            {rows.length}
                          </td>
                          <td className="px-4 py-4 text-right font-data text-base tabular-nums">
                            {poolCredit(d, c) > 0 ? (
                              <Num cents={poolCredit(d, c)} kind="Pool credit" />
                            ) : (
                              <span className="text-off-white/40">—</span>
                            )}
                          </td>
                          <td className="px-4 py-4 text-right font-data text-base tabular-nums">
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
                          <td className="px-4 py-4 text-right">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Hide' : 'Show'} ${POOL_TITLE[c]} allocation rows`}
                              className="font-body text-sm text-off-white/65 hover:text-off-white focus-visible:outline focus-visible:outline-1 rounded-sm px-2 py-1 whitespace-nowrap"
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpen(isOpen ? null : c);
                              }}
                            >
                              {isOpen ? 'Hide rows −' : 'Show rows +'}
                            </button>
                          </td>
                        </tr>
                        {isOpen &&
                          rows.map((r) => (
                            <tr
                              key={r.id}
                              className="bg-purple/[.06] border-t border-off-white/[.05]"
                            >
                              <td />
                              <td colSpan={3} className="px-4 py-3 font-body">
                                {r.target}
                              </td>
                              <td className="px-4 py-3">
                                <span className="inline-flex flex-wrap gap-1 items-center">
                                  <ChannelPill label={r.targetChannel} />
                                  <SourceTag source={r.source} by={r.allocatedBy} />
                                  {r.claim && (
                                    <ClaimTag status={r.claim.status} flagged={r.claim.flagged} />
                                  )}
                                </span>
                              </td>
                              <td
                                className="px-4 py-3 text-right font-data text-base tabular-nums"
                                colSpan={2}
                              >
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
