import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import ChannelPill from '../../components/ChannelPill';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import { apiErrorMessage, type AdminDonation } from '../../types';
import { NotMoneyNote } from '../../components/StaffAmounts';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ModeratorDonations() {
  const [donations, setDonations] = useState<AdminDonation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const undo = async (category: 'poll' | 'goal', id: string) => {
    setError('');
    try {
      await moderatorClient.post(`/unused-pool-money/${category}/${id}/undo`);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Undo failed'));
    }
  };
  const { channels, selectedChannelId } = useModeratorChannelFilter();

  const reload = () => moderatorClient.get('/donations').then((r) => setDonations(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const toggleModerated = async (d: AdminDonation) => {
    await moderatorClient.patch(`/donations/${d.id}`, { moderated: !d.moderated });
    await reload();
  };

  const toggleHidden = async (d: AdminDonation) => {
    // Un-hiding re-adds the donation to the overlay and plays the alert again,
    // so it asks for confirmation first. Hiding needs none.
    if (
      d.hidden_from_overlay &&
      !window.confirm(
        'Show this donation on the stream overlay again? The overlay re-adds it and plays the alert.',
      )
    ) {
      return;
    }
    await moderatorClient.patch(`/donations/${d.id}`, {
      hidden_from_overlay: !d.hidden_from_overlay,
    });
    await reload();
  };

  const channelName = (d: AdminDonation) => {
    if (!d.channel) return 'unassigned';
    return channels.find((e) => e.id === d.channel?.id)?.name ?? 'unknown channel';
  };

  const filteredDonations = donations.filter(
    (d) => !selectedChannelId || d.channel?.id === selectedChannelId || d.channel == null,
  );

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-6">donations</h1>

      {error && <p role="alert">{error}</p>}
      <NotMoneyNote />
      <div className="space-y-4">
        {filteredDonations.map((d) => (
          <Card key={d.id}>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-data font-bold text-sm text-off-white break-words">
                    {d.donor_name ?? '-'}
                  </h3>
                  <ChannelPill label={channelName(d)} />
                </div>
                <span className="font-data text-xs text-off-white/55">Money</span>
                <p className="font-data font-bold text-sm text-d-yellow mt-1">
                  {fmt(d.amount_cents)}
                </p>
                <p className="font-data text-sm">
                  Pledge amount: {d.pledge_amount_cents == null ? '—' : fmt(d.pledge_amount_cents)}
                </p>
                {d.status && d.status !== 'COMPLETED' && (
                  <span className="font-mono">{d.status}</span>
                )}
                {d.comment && (
                  <p className="font-body text-sm text-off-white/55 mt-1 break-words">
                    &ldquo;{d.comment}&rdquo;
                  </p>
                )}
                {(['reward', 'poll', 'goal'] as const).map((category) => (
                  <section key={category} className="mt-2 font-data text-sm">
                    <h4>{category} allocations (live)</h4>
                    {d.allocations?.[category].map((row) => (
                      <div key={row.id} className="flex flex-wrap gap-2">
                        <span>
                          {row.label} · {fmt(row.amount_cents)}
                        </span>
                        <span className="font-mono">{row.source}</span>
                        {row.source === 'moderator' && (
                          <>
                            <span>
                              {row.allocated_by} ·{' '}
                              {row.allocated_at ? new Date(row.allocated_at).toLocaleString() : ''}
                            </span>
                            {category !== 'reward' && (
                              <button className="underline" onClick={() => undo(category, row.id)}>
                                undo
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {category !== 'reward' && (
                      <span>
                        Unused pool money ({category}): {fmt(d.unused_cents?.[category] ?? 0)}
                      </span>
                    )}
                  </section>
                ))}
                <p className="font-data text-xs text-off-white/40 mt-1">
                  {new Date(d.created_at).toLocaleString()}
                </p>
                {d.moderated && (
                  <p className="font-data text-xs text-off-white/40 mt-1 break-words">
                    moderated by {d.moderated_by} &middot;{' '}
                    {d.moderated_at ? new Date(d.moderated_at).toLocaleString() : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 sm:shrink-0">
                {d.hidden_from_overlay && (
                  <span
                    className="font-mono text-sm px-2 py-0.5 rounded-sm font-bold"
                    style={{ background: 'rgba(208,152,70,.16)', color: 'var(--d-yellow)' }}
                  >
                    HIDDEN FROM OVERLAY
                  </span>
                )}
                <span
                  className="font-mono text-sm px-2 py-0.5 rounded-sm font-bold"
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
                <button
                  onClick={() => toggleHidden(d)}
                  className="btrl-button text-xs"
                  style={{ background: d.hidden_from_overlay ? 'var(--green)' : 'var(--d-yellow)' }}
                >
                  {d.hidden_from_overlay ? 'un-hide' : 'hide'}
                </button>
              </div>
            </div>
          </Card>
        ))}
        {filteredDonations.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No donations yet.</p>
        )}
      </div>
    </div>
  );
}
