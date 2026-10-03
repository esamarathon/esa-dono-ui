import { useEffect, useState } from 'react';
import adminClient, { assignDonationChannel } from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
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
  const [tab, setTab] = useState('donations');
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

  const setDonationStatus = async (donation: AdminDonation, status: DonationStatus) => {
    setError('');
    try {
      await adminClient.patch(`/donations/${donation.id}/status`, { status });
      await reloadDonations();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to update donation status'));
    }
  };

  const toggleFulfilled = async (claim: AdminClaim) => {
    const status = claim.status === 'FULFILLED' ? 'PENDING' : 'FULFILLED';
    await adminClient.patch(`/claims/${claim.id}`, { status });
    await reloadClaims();
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
        {['donations', 'claims'].map((t) => (
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
                    'amount',
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
                    <td className="px-4 py-2 font-data text-off-white">{d.donor_name ?? '-'}</td>
                    <td className="px-4 py-2 font-data text-off-white/55">
                      {d.donor?.email ?? '-'}
                    </td>
                    <td className="px-4 py-2 font-data font-bold text-off-white">
                      {fmt(d.amount_cents)}
                    </td>
                    <td className="px-4 py-2 font-data text-off-white/55">{channelName(d)}</td>
                    <td className="px-4 py-2">
                      <select
                        value={d.status}
                        disabled={!!d.refund_id}
                        onChange={(e) => setDonationStatus(d, e.target.value as DonationStatus)}
                        className="font-mono text-sm px-2 py-0.5 rounded-sm font-bold tracking-wider uppercase"
                        style={{
                          background: `${STATUS_COLORS[d.status]}29`,
                          color: STATUS_COLORS[d.status],
                          border: 'none',
                        }}
                      >
                        {DONATION_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
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
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                {['donor', 'reward', 'status', 'data', 'date', 'action'].map((h) => (
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
              {claims.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                  <td className="px-4 py-2 font-data text-off-white">{c.donor?.email ?? '-'}</td>
                  <td className="px-4 py-2 font-data text-off-white">{c.reward?.title ?? '-'}</td>
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
                      className="font-mono text-sm tracking-wider uppercase"
                      style={{
                        color: c.status === 'FULFILLED' ? 'var(--d-yellow)' : 'var(--green)',
                      }}
                    >
                      {c.status === 'FULFILLED' ? 'mark pending' : 'mark fulfilled'}
                    </button>
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
