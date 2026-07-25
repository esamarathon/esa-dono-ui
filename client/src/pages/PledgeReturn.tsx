import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPledge } from '../api/pledge';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import type { Pledge } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PledgeReturn() {
  const { token } = useParams();
  const [pledge, setPledge] = useState<Pledge | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('No pledge token provided.');
      return;
    }
    getPledge(token)
      .then(setPledge)
      .catch(() => setError('Could not load pledge status.'));
  }, [token]);

  if (error) {
    return (
      <div className="max-w-xl mx-auto p-8">
        <Card>
          <h2 className="font-display text-3xl lowercase text-off-white mb-4">pledge status</h2>
          <p className="font-body text-sm" style={{ color: 'var(--red)' }}>
            {error}
          </p>
          <Link to="/" className="btrl-button inline-block mt-4">
            back to home
          </Link>
        </Card>
      </div>
    );
  }

  if (!pledge) return <LoadingSpinner />;

  const isFulfilled = pledge.status === 'FULFILLED';
  const isExpired = pledge.status === 'EXPIRED' || new Date(pledge.expires_at) < new Date();

  return (
    <div className="max-w-xl mx-auto p-8">
      <Card>
        <h2 className="font-display text-3xl lowercase text-off-white mb-4">pledge status</h2>

        {isFulfilled ? (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(92,189,125,.16)' }}>
            <p className="font-data text-sm" style={{ color: 'var(--green)' }}>
              Your pledge has been fulfilled! Check your email for the magic link.
            </p>
          </div>
        ) : isExpired ? (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(208,152,70,.16)' }}>
            <p className="font-data text-sm" style={{ color: 'var(--d-yellow)' }}>
              This pledge has expired. Donations without a matching pledge are credited to your
              wallet balance.
            </p>
          </div>
        ) : (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(115,78,158,.3)' }}>
            <p className="font-data text-sm text-off-white">
              Pending — waiting for your donation to be processed on Tiltify.
            </p>
          </div>
        )}

        <div className="btrl-panel p-4 mb-4">
          <p className="font-data text-sm text-off-white/55 mb-1">pledge total</p>
          <p className="font-display text-3xl text-d-yellow">{fmt(pledge.total_cents)}</p>
        </div>

        {pledge.items.length > 0 && (
          <div className="mb-4">
            <h3 className="font-data font-bold text-sm text-off-white mb-2 uppercase tracking-wider">
              items
            </h3>
            <div className="space-y-1">
              {pledge.items.map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="font-data text-off-white">
                    {item.kind === 'REWARD'
                      ? 'Reward'
                      : item.kind === 'POLL_VOTE'
                        ? 'Poll Vote'
                        : 'Goal Contribution'}
                  </span>
                  <span className="font-data text-d-yellow">{fmt(item.amount_cents)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Link to="/" className="btrl-button">
            back to home
          </Link>
          <Link to="/wallet" className="btrl-button btrl-button-outline">
            my wallet
          </Link>
        </div>
      </Card>
    </div>
  );
}
