import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import EventPill from '../../components/EventPill';
import { useModeratorEventFilter } from '../../context/ModeratorEventFilterContext';
import type { AdminClaim } from '../../types';

function claimField(claim: AdminClaim, key: 'name' | 'message'): string | undefined {
  const data = claim.claim_data as Record<string, unknown> | null | undefined;
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

export default function ModeratorClaims() {
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const { events, selectedEventId } = useModeratorEventFilter();

  const reload = () => moderatorClient.get('/claims').then((r) => setClaims(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const eventName = (c: AdminClaim) => {
    if (!c.reward?.event_id) return 'shared';
    return events.find((e) => e.id === c.reward?.event_id)?.name ?? 'unknown event';
  };

  const toggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'PENDING' ? 'FULFILLED' : 'PENDING';
    await moderatorClient.patch(`/claims/${id}`, { status: newStatus });
    await reload();
  };

  const filteredClaims = claims.filter(
    (c) => !selectedEventId || c.reward?.event_id === selectedEventId || c.reward?.event_id == null,
  );

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-6">claims</h1>

      <div className="space-y-4">
        {filteredClaims.map((c) => {
          const name = claimField(c, 'name');
          const message = claimField(c, 'message');
          return (
            <Card key={c.id}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-data font-bold text-sm text-off-white">
                      {c.reward?.title}
                    </h3>
                    <EventPill label={eventName(c)} />
                  </div>
                  <p className="font-data text-xs text-off-white/55">type: {c.reward?.type}</p>
                  {name && <p className="font-data text-xs text-off-white/55">donor: {name}</p>}
                  {message && (
                    <p className="font-body text-sm text-off-white/55 mt-1">
                      &ldquo;{message}&rdquo;
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
                    style={{
                      background:
                        c.status === 'FULFILLED' ? 'rgba(92,189,125,.16)' : 'rgba(208,152,70,.16)',
                      color: c.status === 'FULFILLED' ? 'var(--green)' : 'var(--d-yellow)',
                    }}
                  >
                    {c.status}
                  </span>
                  <button
                    onClick={() => toggleStatus(c.id, c.status)}
                    className="btrl-button text-xs"
                    style={{
                      background: c.status === 'PENDING' ? 'var(--green)' : 'var(--d-yellow)',
                    }}
                  >
                    {c.status === 'PENDING' ? 'mark fulfilled' : 'mark pending'}
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
        {filteredClaims.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No claims yet.</p>
        )}
      </div>
    </div>
  );
}
