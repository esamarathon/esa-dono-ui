// THROWAWAY (#172): admin donations list (Q3) and the claims tab's donation link (Q2).
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { STATUSES, flags, liveRows, needsAttention, type StaffModel, type Status } from './model';
import {
  ChannelLabel,
  ClaimTag,
  DonationLink,
  FilterChip,
  FlagChip,
  Money,
  NotMoneyNote,
  Num,
  Placeholder,
  STATUS_COLORS,
  StatusChip,
  TH,
} from './shared';

export default function DonationsList({ m }: { m: StaffModel }) {
  const [tab, setTab] = useState<'donations' | 'claims'>('donations');
  const [statusFilter, setStatusFilter] = useState<Status[]>([]);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const navigate = useNavigate();
  const search = useLocation().search;

  const attentionCount = m.donations.filter(needsAttention).length;
  const visible = m.donations.filter(
    (d) =>
      (statusFilter.length === 0 || statusFilter.includes(d.status)) &&
      (!unassignedOnly || d.channel === null) &&
      (!attentionOnly || needsAttention(d)),
  );

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-4">donations & claims</h1>
      <div className="flex gap-2 mb-4">
        {(['donations', 'claims'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="btrl-button"
            style={
              tab !== t
                ? {
                    background: 'transparent',
                    border: '2px solid rgba(239,238,236,.15)',
                    textShadow: 'none',
                  }
                : {}
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'donations' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-3">
            <FilterChip
              label={`needs attention (${attentionCount})`}
              active={attentionOnly}
              color="var(--red)"
              onClick={() => setAttentionOnly((v) => !v)}
            />
            {STATUSES.map((s) => (
              <FilterChip
                key={s}
                label={s}
                active={statusFilter.includes(s)}
                color={STATUS_COLORS[s]}
                onClick={() =>
                  setStatusFilter((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]))
                }
              />
            ))}
            <FilterChip
              label="unassigned only"
              active={unassignedOnly}
              color="var(--d-yellow)"
              onClick={() => setUnassignedOnly((v) => !v)}
            />
          </div>
          <p className="font-body text-xs text-off-white/55 mb-3">
            <span className="text-d-yellow font-bold">Money</span> is the new money of the donation.
            Pledge amount is not money: it includes Wallet credit applied.
          </p>
          <div className="mb-3">
            <NotMoneyNote />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                  {[
                    'donor',
                    'email',
                    'money',
                    'pledge amount',
                    'channel',
                    'status',
                    'flags',
                    'comment',
                    'date',
                    'assign',
                  ].map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr
                    key={d.id}
                    data-testid={`row-${d.id}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a, button, select')) return;
                      navigate(`/admin/donations/${d.id}${search}`);
                    }}
                    className="cursor-pointer hover:bg-[rgba(239,238,236,.04)]"
                    style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
                  >
                    <td className="px-3 py-2 font-data">
                      <DonationLink id={d.id}>{d.donorName}</DonationLink>
                    </td>
                    <td className="px-3 py-2 font-data text-off-white/55">{d.email}</td>
                    <td className="px-3 py-2">
                      <Money cents={d.amountCents} />
                    </td>
                    <td className="px-3 py-2">
                      {d.pledge ? (
                        <Num cents={d.pledge.pledgeCents} kind="pledge amount" />
                      ) : (
                        <span className="font-data text-off-white/55" title="no pledge">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ChannelLabel d={d} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={d.status} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 min-w-[10rem]">
                        {flags(d).map((f) => (
                          <FlagChip key={f} flag={f} />
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-body text-sm text-off-white/55 max-w-xs break-words">
                      {d.comment ?? '-'}
                    </td>
                    <td className="px-3 py-2 font-data text-off-white/55 whitespace-nowrap">
                      {d.createdAt.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-off-white/40">
                      {d.channel === null ? 'assign…' : ''}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 font-body text-off-white/55">
                      No donations match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-6 max-w-3xl">
            <Placeholder title="Q5: manual PENDING ↔ COMPLETED status change">
              <p>
                The status dropdown is gone from the list (Q4). Whether an admin can still move a
                donation between PENDING and COMPLETED anywhere is open.
              </p>
            </Placeholder>
          </div>
        </div>
      )}

      {tab === 'claims' && (
        <div>
          <div className="max-w-3xl mb-4">
            <Placeholder title="claims tab beyond the donation link">
              <p>
                Decided: each claim links to its donation detail page (Q2). Not decided: claim
                actions, the recorded claim amount, CANCELLING claims, and how a flagged shipped
                claim is acknowledged. The current mark fulfilled / mark pending action is left out.
              </p>
            </Placeholder>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                  {['donor', 'reward', 'status', 'date', 'donation'].map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.donations.flatMap((d) =>
                  d.rows
                    .filter((r) => r.claim)
                    .map((r) => (
                      <tr key={r.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                        <td className="px-3 py-2 font-data text-off-white">{d.email}</td>
                        <td className="px-3 py-2 font-data text-off-white">{r.target}</td>
                        <td className="px-3 py-2">
                          <ClaimTag status={r.claim!.status} flagged={r.claim!.flagged} />
                        </td>
                        <td className="px-3 py-2 font-data text-off-white/55">
                          {d.createdAt.slice(0, 10)}
                        </td>
                        <td className="px-3 py-2 font-data">
                          <DonationLink id={d.id}>{d.donorName}&apos;s donation →</DonationLink>
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
          <p className="font-mono text-xs text-off-white/40 mt-2">
            {m.donations.reduce((s, d) => s + liveRows(d, 'reward').length, 0)} live claims in the
            fixtures.
          </p>
        </div>
      )}
    </div>
  );
}
