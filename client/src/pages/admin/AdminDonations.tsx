import { useEffect, useState } from 'react';
import adminClient, { assignDonationChannel } from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
import PaymentRefunds from './PaymentRefunds';
import { NotMoneyNote } from '../../components/StaffAmounts';
import {
  apiErrorMessage,
  type AdminDonation,
  type AdminClaim,
  type Channel,
  type DonationStatus,
} from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const DONATION_STATUSES: DonationStatus[] = ['PENDING', 'COMPLETED', 'REFUNDED', 'CHARGEBACK'];

const STATUS_COLORS: Record<DonationStatus, string> = {
  PENDING: 'var(--d-yellow)',
  COMPLETED: 'var(--green)',
  REFUNDED: 'var(--d-yellow)',
  CHARGEBACK: 'var(--red, #e05252)',
};

export default function AdminDonations() {
  const [donations, setDonations] = useState<AdminDonation[]>([]);
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).get('tab') === 'payment-refunds'
      ? 'payment refunds'
      : 'donations',
  );
  const [statusFilter, setStatusFilter] = useState<DonationStatus[]>([]);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [assignChoice, setAssignChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const reloadClaims = () => adminClient.get('/claims').then((r) => setClaims(r.data));
  const reloadDonations = (statuses: DonationStatus[] = statusFilter) =>
    adminClient
      .get('/donations', { params: statuses.length > 0 ? { status: statuses.join(',') } : {} })
      .then((r) => setDonations(r.data));

  useEffect(() => {
    Promise.all([
      reloadDonations([]),
      reloadClaims(),
      adminClient.get('/channels').then((r) => setChannels(r.data)),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleStatusFilter = async (status: DonationStatus) => {
    const next = statusFilter.includes(status)
      ? statusFilter.filter((s) => s !== status)
      : [...statusFilter, status];
    setStatusFilter(next);
    await reloadDonations(next);
  };

  const toggleFulfilled = async (claim: AdminClaim) => {
    const status = claim.status === 'FULFILLED' ? 'PENDING' : 'FULFILLED';
    setError('');
    try {
      await adminClient.patch(`/claims/${claim.id}`, { status });
      await reloadClaims();
    } catch (e) {
      setError(apiErrorMessage(e, 'Claim status change failed'));
    }
  };

  /** A donation that named no event and no channel — it is not published until
   *  an admin assigns it one (#115). */
  const isUnassigned = (d: AdminDonation) => d.channel_id === null && d.event_id === null;

  const channelName = (d: AdminDonation) => d.channel?.name ?? 'unassigned';

  const handleAssign = async (d: AdminDonation) => {
    const choice = assignChoice[d.id];
    if (!choice) return;
    setError('');
    try {
      await assignDonationChannel(d.id, choice);
      await reloadDonations();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to assign donation'));
    }
  };

  const visibleDonations = unassignedOnly ? donations.filter(isUnassigned) : donations;

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-4">donations & claims</h1>
      <div className="flex gap-2 mb-4">
        {['donations', 'claims', 'payment refunds'].map((t) => (
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

      <NotMoneyNote />
      {tab === 'payment refunds' && <PaymentRefunds />}
      {tab === 'donations' && (
        <div>
          {error && (
            <p className="font-body text-sm mb-3" style={{ color: 'var(--red, #e05252)' }}>
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 mb-3">
            {DONATION_STATUSES.map((s) => {
              const active = statusFilter.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatusFilter(s)}
                  className="font-mono text-sm px-2 py-1 rounded-sm font-bold tracking-wider uppercase"
                  style={{
                    background: active ? `${STATUS_COLORS[s]}29` : 'transparent',
                    border: `1px solid ${active ? STATUS_COLORS[s] : 'rgba(239,238,236,.15)'}`,
                    color: active ? STATUS_COLORS[s] : 'var(--off-white, #efeeec)',
                    opacity: active ? 1 : 0.55,
                  }}
                >
                  {s}
                </button>
              );
            })}
            <button
              onClick={() => setUnassignedOnly((v) => !v)}
              className="font-mono text-sm px-2 py-1 rounded-sm font-bold tracking-wider uppercase"
              style={{
                background: unassignedOnly ? 'rgba(208,152,70,.16)' : 'transparent',
                border: `1px solid ${unassignedOnly ? 'var(--d-yellow)' : 'rgba(239,238,236,.15)'}`,
                color: unassignedOnly ? 'var(--d-yellow)' : 'var(--off-white, #efeeec)',
                opacity: unassignedOnly ? 1 : 0.55,
              }}
            >
              unassigned only
            </button>
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
                    'flags / attention',
                    'channel',
                    'status',
                    'comment',
                    'date',
                    'assign',
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleDonations.map((d) => (
                  <tr key={d.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                    <td className="px-4 py-2 font-data text-off-white">
                      <a href={`/admin/donations/${d.id}`} className="underline">
                        {d.donor_name ?? 'Anonymous'}
                      </a>
                    </td>
                    <td className="px-4 py-2 font-data text-off-white/55">
                      {d.donor?.email ?? '-'}
                    </td>
                    <td className="px-4 py-2 font-data font-bold text-d-yellow">
                      {fmt(d.amount_cents)}
                    </td>
                    <td className="px-4 py-2 font-data">
                      {d.pledge_amount_cents == null ? '—' : fmt(d.pledge_amount_cents)}
                    </td>
                    <td className="px-4 py-2 font-data">
                      {d.needs_attention && <strong>Needs attention · </strong>}
                      {d.flags?.join(' · ')}
                    </td>
                    <td className="px-4 py-2 font-data text-off-white/55">{channelName(d)}</td>
                    <td className="px-4 py-2">
                      <span
                        className="font-mono text-sm font-bold"
                        style={{ color: STATUS_COLORS[d.status] }}
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-body text-sm text-off-white/55 max-w-xs break-words">
                      {d.comment ?? '-'}
                    </td>
                    <td className="px-4 py-2 font-data text-off-white/55">
                      {new Date(d.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      {isUnassigned(d) && (
                        <div className="flex items-center gap-1">
                          <select
                            aria-label={`assign channel for ${d.id}`}
                            className="font-mono text-sm px-1 py-0.5 rounded-sm"
                            value={assignChoice[d.id] ?? ''}
                            onChange={(e) =>
                              setAssignChoice((prev) => ({ ...prev, [d.id]: e.target.value }))
                            }
                          >
                            <option value="">channel…</option>
                            {channels.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleAssign(d)}
                            disabled={!assignChoice[d.id]}
                            className="font-mono text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
                          >
                            assign…
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'claims' && (
        <div className="overflow-x-auto">
          {error && <p role="alert">{error}</p>}
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                {['donor', 'reward / recorded allocation', 'status', 'data', 'date', 'action'].map(
                  (h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                  <td className="px-4 py-2 font-data text-off-white">{c.donor?.email ?? '-'}</td>
                  <td className="px-4 py-2 font-data text-off-white">
                    {c.reward?.title ?? '-'}
                    <p>
                      {fmt(c.amount_cents)} recorded (price now {fmt(c.reward?.cost_cents ?? 0)})
                    </p>
                    {(c.funding_donation_ids ?? (c.donation_id ? [c.donation_id] : [])).map(
                      (id) => (
                        <a key={id} href={`/admin/donations/${id}`} className="underline block">
                          Donation {id}
                        </a>
                      ),
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className="font-mono text-sm px-2 py-0.5 rounded-sm font-bold"
                      style={{
                        background:
                          c.status === 'FULFILLED'
                            ? 'rgba(92,189,125,.16)'
                            : 'rgba(208,152,70,.16)',
                        color: c.status === 'FULFILLED' ? 'var(--green)' : 'var(--d-yellow)',
                      }}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-body text-sm text-off-white/55 max-w-xs truncate">
                    {c.claim_data ? JSON.stringify(c.claim_data) : '-'}
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => toggleFulfilled(c)}
                      disabled={
                        !!c.toggle_disabled_reason || !['PENDING', 'FULFILLED'].includes(c.status)
                      }
                      title={c.toggle_disabled_reason ?? undefined}
                      className="font-mono text-sm tracking-wider uppercase"
                      style={{
                        color: c.status === 'FULFILLED' ? 'var(--d-yellow)' : 'var(--green)',
                      }}
                    >
                      {c.status === 'FULFILLED' ? 'mark pending' : 'mark fulfilled'}
                    </button>
                    {c.toggle_disabled_reason && <p>{c.toggle_disabled_reason}</p>}
                    {c.chargeback_flagged_at && <span>Shipped claim after chargeback</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
