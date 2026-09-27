import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import ChannelPill from '../../components/ChannelPill';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import type { AdminClaim } from '../../types';

function claimField(claim: AdminClaim, key: 'name' | 'message'): string | undefined {
  const data = claim.claim_data as Record<string, unknown> | null | undefined;
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

export default function ModeratorClaims() {
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const { channels, selectedChannelId } = useModeratorChannelFilter();

  const reload = () => moderatorClient.get('/claims').then((r) => setClaims(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const channelName = (c: AdminClaim) => {
    if (!c.reward?.channel_id) return 'shared';
    return channels.find((e) => e.id === c.reward?.channel_id)?.name ?? 'unknown channel';
  };

  const filteredClaims = claims.filter(
    (c) =>
      !selectedChannelId ||
      c.reward?.channel_id === selectedChannelId ||
      c.reward?.channel_id == null,
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
                    <ChannelPill label={channelName(c)} />
                  </div>
                  <p className="font-data text-xs text-off-white/55">type: {c.reward?.type}</p>
                  <p className="font-data text-xs text-off-white/55">
                    donor: {c.donor_name || 'Anonymous'}
                  </p>
                  {name && (
                    <p className="font-data text-xs text-off-white/55">entered name: {name}</p>
                  )}
                  {message && (
                    <p className="font-body text-sm text-off-white/55 mt-1">
                      &ldquo;{message}&rdquo;
                    </p>
                  )}
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
