import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import type { AdminStats } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminClient
      .get('/stats')
      .then((r) => setStats(r.data))
      .catch(() => setError('Failed to load stats.'));
  }, []);

  if (error) return <p style={{ color: 'var(--red)' }}>{error}</p>;
  if (!stats) return <LoadingSpinner />;

  const cards = [
    { label: 'total raised', value: fmt(stats.total_raised_cents) },
    { label: 'donors', value: stats.donors },
    { label: 'donations', value: stats.donations },
    { label: 'reward claims', value: stats.claims },
    { label: 'pledges', value: stats.pledges },
  ];

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-6">dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c) => (
          <Card key={c.label} className="text-center">
            <p className="font-data text-sm text-off-white/55">{c.label}</p>
            <p className="font-display text-3xl text-d-yellow mt-1">{c.value}</p>
          </Card>
        ))}
      </div>

      {stats.channels && stats.channels.length > 0 && (
        <div className="mt-8">
          <h2 className="font-display text-2xl uppercase mb-4">per-channel totals</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(239,238,236,.03)' }}>
                  {['channel', 'raised', 'donations'].map((h) => (
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
                {stats.channels.map((s) => (
                  <tr key={s.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                    <td className="px-4 py-2 font-data font-bold text-off-white">{s.name}</td>
                    <td className="px-4 py-2 font-data text-d-yellow">{fmt(s.raised_cents)}</td>
                    <td className="px-4 py-2 font-data text-off-white/55">{s.donations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
