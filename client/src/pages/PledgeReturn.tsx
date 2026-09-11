import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getPledge } from '../api/pledge';
import { isSessionActive } from '../utils/authToken';
import { track } from '../lib/tracing';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import type { Pledge } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;

export default function PledgeReturn() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [pledge, setPledge] = useState<Pledge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    if (!token) {
      setError('No pledge token provided.');
      return;
    }
    track('pledge_return', { 'pledge.token': token });

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (cancelled) return;
      attempts.current += 1;
      try {
        const data = await getPledge(token);
        if (cancelled) return;
        setPledge(data);

        if (data.status === 'FULFILLED') {
          // Never auto-authenticate from a pledge return — that would let
          // anyone gain a session by paying to someone else's email (#48).
          // The magic link (emailed on every donation) is the only way to
          // establish a new session. But if this browser already has an
          // active session (a returning, logged-in donor), just take them
          // straight to their wallet — no need to make them click the link
          // again for their 2nd, 3rd, ... donation.
          if (isSessionActive()) {
            navigate('/wallet');
          }
          return;
        }
        if (data.status === 'EXPIRED' || new Date(data.expires_at) < new Date()) {
          return;
        }
      } catch {
        if (cancelled) return;
        setError('Could not load pledge status.');
        return;
      }

      if (attempts.current >= POLL_MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, navigate]);

  if (error) {
    return (
      <div className="max-w-xl mx-auto p-8">
        <Card>
          <h2 className="font-display text-3xl uppercase text-off-white mb-4">pledge status</h2>
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
        <h2 className="font-display text-3xl uppercase text-off-white mb-4">pledge status</h2>

        {isFulfilled ? (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(92,189,125,.16)' }}>
            <p className="font-data text-sm" style={{ color: 'var(--green)' }}>
              Your pledge has been fulfilled! Check your email for the magic link.
            </p>
          </div>
        ) : isExpired ? (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(208,152,70,.16)' }}>
            <p className="font-data text-sm" style={{ color: 'var(--d-yellow)' }}>
              This pledge has expired. Pledges without a matching payment are credited to your
              wallet balance.
            </p>
          </div>
        ) : timedOut ? (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(208,152,70,.16)' }}>
            <p className="font-data text-sm" style={{ color: 'var(--d-yellow)' }}>
              Still processing your donation. Check your email for the magic link — it may take a
              moment to arrive.
            </p>
          </div>
        ) : (
          <div className="mb-4 p-3 rounded-sm" style={{ background: 'rgba(115,78,158,.3)' }}>
            <p className="font-data text-sm text-off-white">
              Processing your pledge... this usually takes a few seconds.
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
