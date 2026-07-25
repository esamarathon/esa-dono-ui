import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
import type { AdminDonation, AdminClaim } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AdminDonations() {
  const [donations, setDonations] = useState<AdminDonation[]>([]);
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('donations');

  const reloadClaims = () => adminClient.get('/claims').then((r) => setClaims(r.data));
  const reloadDonations = () => adminClient.get('/donations').then((r) => setDonations(r.data));

  useEffect(() => {
    Promise.all([reloadDonations(), reloadClaims()]).finally(() => setLoading(false));
  }, []);

  const toggleFulfilled = async (claim: AdminClaim) => {
    const status = claim.status === 'FULFILLED' ? 'PENDING' : 'FULFILLED';
    await adminClient.patch(`/claims/${claim.id}`, { status });
    await reloadClaims();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl lowercase mb-4">donations & claims</h1>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                {['donor', 'email', 'amount', 'comment', 'date'].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {donations.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                  <td className="px-4 py-2 font-data text-off-white">{d.donor_name ?? '-'}</td>
                  <td className="px-4 py-2 font-data text-off-white/55">{d.donor?.email ?? '-'}</td>
                  <td className="px-4 py-2 font-data font-bold text-off-white">
                    {fmt(d.amount_cents)}
                  </td>
                  <td className="px-4 py-2 font-body text-sm text-off-white/55">
                    {d.comment ?? '-'}
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">
                    {new Date(d.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                    className="text-left px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55"
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
                      className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
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
                      className="font-mono text-[10px] tracking-wider uppercase"
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
