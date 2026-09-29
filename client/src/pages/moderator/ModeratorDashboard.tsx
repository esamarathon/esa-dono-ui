import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import type { ModeratorStats } from '../../types';

export default function ModeratorDashboard() {
  const [stats, setStats] = useState<ModeratorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    moderatorClient
      .get('/stats')
      .then((r) => setStats(r.data))
      .catch(() => setError('Unable to load moderator stats. Your access may have expired.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error || !stats) {
    return (
      <p className="font-body text-sm" style={{ color: 'var(--red)' }}>
        {error || 'No data available.'}
      </p>
    );
  }

  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-6">moderator dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <div className="font-display text-3xl text-d-yellow">{stats.pending_entries}</div>
          <div className="font-data text-sm text-off-white/55">pending entries</div>
        </Card>
        <Card>
          <div className="font-display text-3xl text-d-yellow">{stats.active_polls}</div>
          <div className="font-data text-sm text-off-white/55">active polls</div>
        </Card>
        <Card>
          <div className="font-display text-3xl text-d-yellow">{stats.total_rewards}</div>
          <div className="font-data text-sm text-off-white/55">active rewards</div>
        </Card>
        <Card>
          <div className="font-display text-3xl text-d-yellow">{stats.total_goals}</div>
          <div className="font-data text-sm text-off-white/55">active goals</div>
        </Card>
      </div>
    </div>
  );
}
