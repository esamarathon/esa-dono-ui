// THROWAWAY (#172) variant B: one allocation ledger on the left, a sticky side rail with the
// donation's facts, attention items and actions on the right.
import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ChannelPill from '../../../components/ChannelPill';
import {
  ATTENTION_FLAGS,
  flags,
  liveRows,
  poolCredit,
  sumRows,
  unusedPool,
  type Donation,
  type StaffModel,
} from './model';
import {
  EndedTargets,
  Facts,
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
  NotMoneyNote,
  Num,
  POOL_TITLE,
  SourceTag,
  StatusActions,
  StatusChip,
  TH,
} from './shared';

export default function DetailB({ m, d }: { m: StaffModel; d: Donation }) {
  const search = useLocation().search;
  const fs = flags(d);
  const attention = fs.filter((f) => ATTENTION_FLAGS.includes(f));
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr),22rem] gap-6 items-start">
      <div className="space-y-6 min-w-0">
        <div>
          <Link to={`/admin/donations${search}`} className="font-mono text-sm text-off-white/55">
            ← donations
          </Link>
          <h1 className="font-display text-4xl uppercase mt-2">
            {d.donorName} <span className="text-off-white/40 text-2xl">{d.id}</span>
          </h1>
        </div>

        <section>
          <h2 className="font-display text-2xl uppercase mb-1">Allocation ledger</h2>
          {d.pledge ? (
            <>
              <div className="mb-2">
                <NotMoneyNote />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                      {['target', 'channel', 'source', 'claim', 'amount'].map((h) => (
                        <TH key={h}>{h}</TH>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {categoriesWithPools(d).map((c) => {
                      const rows = liveRows(d, c);
                      return (
                        <Fragment key={c}>
                          <tr style={{ background: 'rgba(115,78,158,.18)' }}>
                            <td colSpan={4} className="px-3 py-1.5 font-display text-lg uppercase">
                              {POOL_TITLE[c]} Pool
                            </td>
                            <td className="px-3 py-1.5 font-data text-sm text-off-white/70 whitespace-nowrap">
                              Pool <Num cents={d.pledge!.pledgeCents} kind="Pool size" />
                            </td>
                          </tr>
                          {rows.length === 0 && (
                            <tr>
                              <td colSpan={5} className="px-3 py-2 text-off-white/50">
                                No live rows.
                              </td>
                            </tr>
                          )}
                          {rows.map((r) => (
                            <tr key={r.id} style={{ borderTop: '1px solid rgba(239,238,236,.06)' }}>
                              <td className="px-3 py-2 font-body">{r.target}</td>
                              <td className="px-3 py-2">
                                <ChannelPill label={r.targetChannel} />
                              </td>
                              <td className="px-3 py-2">
                                <SourceTag source={r.source} by={r.allocatedBy} />
                              </td>
                              <td className="px-3 py-2">
                                {r.claim ? (
                                  <ClaimTag status={r.claim.status} flagged={r.claim.flagged} />
                                ) : (
                                  ''
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <Num cents={r.cents} kind="allocated" />
                              </td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: '1px solid rgba(239,238,236,.12)' }}>
                            <td
                              colSpan={4}
                              className="px-3 py-1 text-right font-data text-off-white/60"
                            >
                              {POOL_TITLE[c].toLowerCase()} allocated (live)
                            </td>
                            <td className="px-3 py-1">
                              <Num cents={sumRows(rows)} kind="allocated" />
                            </td>
                          </tr>
                          {poolCredit(d, c) > 0 && (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-3 py-1 text-right font-data text-off-white/60"
                              >
                                Pool credit
                              </td>
                              <td className="px-3 py-1">
                                <Num cents={poolCredit(d, c)} kind="Pool credit" />
                              </td>
                            </tr>
                          )}
                          {c !== 'reward' && (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-3 py-1 pb-3 text-right font-data text-off-white/60"
                              >
                                Unused pool money
                              </td>
                              <td className="px-3 py-1 pb-3">
                                <Num cents={unusedPool(d, c)} kind="Unused pool money" />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <NoPools d={d} />
          )}
        </section>

        <section>
          <h2 className="font-display text-2xl uppercase mb-2">Payment refunds</h2>
          <PaymentRefunds d={d} />
        </section>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h2 className="font-display text-xl uppercase mb-2">Ended targets changed</h2>
            <EndedTargets d={d} />
          </section>
          <section>
            <h2 className="font-display text-xl uppercase mb-2">Flagged shipped claims</h2>
            <FlaggedClaims d={d} />
          </section>
        </div>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-0">
        <div className="btrl-panel-dark p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-data text-off-white/60">status</span>
            <StatusChip status={d.status} />
          </div>
          <Facts d={d} vertical />
        </div>
        <div className="btrl-panel-dark p-4 space-y-2">
          <h3 className="font-display text-xl uppercase">Needs attention</h3>
          {attention.length === 0 ? (
            <p className="font-body text-sm text-off-white/55">Nothing.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {attention.map((f) => (
                <FlagChip key={f} flag={f} />
              ))}
            </div>
          )}
          {fs.filter((f) => !attention.includes(f)).length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {fs
                .filter((f) => !attention.includes(f))
                .map((f) => (
                  <FlagChip key={f} flag={f} />
                ))}
            </div>
          )}
        </div>
        <div className="btrl-panel-dark p-4 space-y-3">
          <h3 className="font-display text-xl uppercase">Actions</h3>
          <StatusActions m={m} d={d} />
          <Q5Placeholder />
        </div>
        <div className="btrl-panel-dark p-4">
          <Identity d={d} />
        </div>
      </aside>
    </div>
  );
}
