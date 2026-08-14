import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import type { AdminDonation } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ModeratorDonations() {
  const [donations, setDonations] = useState<AdminDonation[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = () => moderatorClient.get('/donations').then((r) => setDonations(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const toggleModerated = async (d: AdminDonation) => {
    await moderatorClient.patch(`/donations/${d.id}`, { moderated: !d.moderated });
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl lowercase mb-6">donations</h1>

      <div className="space-y-4">
        {donations.map((d) => (
          <Card key={d.id}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-data font-bold text-sm text-off-white">
                  {d.donor_name ?? '-'}
                </h3>
                <p className="font-data text-xs text-off-white/55">
                  donor: {d.donor?.email ?? '-'}
                </p>
                <p className="font-data font-bold text-sm text-d-yellow mt-1">
                  {fmt(d.amount_cents)}
                </p>
                {d.comment && (
                  <p className="font-body text-sm text-off-white/55 mt-1 max-w-md">
                    &ldquo;{d.comment}&rdquo;
                  </p>
                )}
                <p className="font-data text-xs text-off-white/40 mt-1">
                  {new Date(d.created_at).toLocaleString()}
                </p>
                {d.moderated && (
                  <p className="font-data text-xs text-off-white/40 mt-1">
                    moderated by {d.moderated_by} &middot;{' '}
                    {d.moderated_at ? new Date(d.moderated_at).toLocaleString() : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
                  style={{
                    background: d.moderated ? 'rgba(92,189,125,.16)' : 'rgba(208,152,70,.16)',
                    color: d.moderated ? 'var(--green)' : 'var(--d-yellow)',
                  }}
                >
                  {d.moderated ? 'MODERATED' : 'UNMODERATED'}
                </span>
                <button
                  onClick={() => toggleModerated(d)}
                  className="btrl-button text-xs"
                  style={{ background: d.moderated ? 'var(--d-yellow)' : 'var(--green)' }}
                >
                  {d.moderated ? 'unmark moderated' : 'mark moderated'}
                </button>
              </div>
            </div>
          </Card>
        ))}
        {donations.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No donations yet.</p>
        )}
      </div>
    </div>
  );
}
