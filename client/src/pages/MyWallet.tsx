import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { getDonor, requestToken } from '../api/donor';
import { getOAuthProviders } from '../api/auth';
import { track, identifyDonor } from '../lib/tracing';
import {
  extractToken,
  startSession,
  endSession,
  noteSessionEstablished,
  clearSessionMarker,
} from '../utils/authToken';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import type { DonorWallet } from '../types';
import { hasModeratorAccess } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function WalletLogin({
  message,
  onLogin,
}: {
  message: string | null;
  onLogin: (token: string) => void;
}) {
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [emailStatus, setEmailStatus] = useState<null | { kind: 'ok' | 'error'; text: string }>(
    null,
  );
  const [emailBusy, setEmailBusy] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    getOAuthProviders()
      .then((p) => setProviders(p.providers))
      .catch(() => setProviders([]));
  }, []);

  const submit = () => {
    const token = extractToken(input);
    if (!token) {
      setFormError('Paste the full magic link from your email, or paste just the token value.');
      return;
    }
    setFormError('');
    onLogin(token);
  };

  const submitEmail = async () => {
    const email = emailInput.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailStatus({ kind: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setEmailBusy(true);
    setEmailStatus(null);
    try {
      await requestToken(email);
      setEmailStatus({
        kind: 'ok',
        text: 'If that email has donated, a fresh link is on its way. Check your inbox.',
      });
    } catch {
      setEmailStatus({ kind: 'error', text: 'Something went wrong. Please try again shortly.' });
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto p-8">
      <h1 className="font-display text-4xl uppercase mb-4">access your wallet</h1>
      <Card>
        {message && (
          <p className="text-sm mb-4" style={{ color: 'var(--red)' }}>
            {message}
          </p>
        )}
        <div className="space-y-3 font-body text-sm text-off-white/55 mb-5">
          <p>
            Your wallet is unlocked by the magic link emailed after each donation. There are no
            passwords or account signups.
          </p>
          <p>
            Your wallet link stays the same after each donation. If it ever stops working, use the
            newest donation email to refresh it.
          </p>
          <p>Paste either the entire email link or just the token below.</p>
        </div>

        <label className="block font-data font-bold text-sm mb-1 text-off-white">
          magic link or token
        </label>
        <input
          className="w-full px-3 py-2 text-sm mb-2"
          placeholder="https://.../wallet?token=..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {formError && (
          <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>
            {formError}
          </p>
        )}
        <button onClick={submit} className="btrl-button">
          open wallet
        </button>

        <div
          className="mt-6 pt-5 flex items-center gap-3 font-data text-xs text-off-white/45"
          style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
        >
          <span className="flex-1 h-px" style={{ background: 'rgba(239,238,236,.08)' }} />
          <span>lost your link?</span>
          <span className="flex-1 h-px" style={{ background: 'rgba(239,238,236,.08)' }} />
        </div>

        <label className="block font-data font-bold text-sm mb-1 mt-5 text-off-white">
          email a new link
        </label>
        <input
          className="w-full px-3 py-2 text-sm mb-2"
          placeholder="you@example.com"
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
        />
        {emailStatus && (
          <p
            className="text-sm mb-3"
            style={{ color: emailStatus.kind === 'ok' ? 'var(--green)' : 'var(--red)' }}
          >
            {emailStatus.text}
          </p>
        )}
        <button onClick={submitEmail} disabled={emailBusy} className="btrl-button">
          {emailBusy ? 'sending…' : 'send me a new link'}
        </button>

        {providers.length > 0 && (
          <>
            <div
              className="mt-6 pt-5 flex items-center gap-3 font-data text-xs text-off-white/45"
              style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
            >
              <span className="flex-1 h-px" style={{ background: 'rgba(239,238,236,.08)' }} />
              <span>or sign in with</span>
              <span className="flex-1 h-px" style={{ background: 'rgba(239,238,236,.08)' }} />
            </div>
            <div className="grid gap-2 mt-5">
              {providers.map((p) => (
                <a
                  key={p}
                  href={`/api/auth/${p}`}
                  className="btrl-button block text-center no-underline"
                >
                  sign in with {p}
                </a>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export default function MyWallet() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [donor, setDonor] = useState<DonorWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDonor = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getDonor();
      setDonor(data);
      setError(null);
      noteSessionEstablished();
      track('wallet_view', {});
      identifyDonor(data.id, data.email);
    } catch {
      setDonor(null);
      clearSessionMarker();
      setError(
        'No active wallet session. Open the newest magic link from your donation email, or sign in below.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const token = searchParams.get('token');
    const urlError = searchParams.get('error');

    if (token) {
      // Fallback path (e.g. a pasted ?token= link): exchange it for the
      // httpOnly session cookie, then strip it from the URL.
      startSession(token)
        .catch(() => undefined)
        .finally(() => {
          window.history.replaceState(null, '', window.location.pathname);
          loadDonor();
        });
      return;
    }

    if (urlError) {
      setDonor(null);
      setError(urlError);
      setLoading(false);
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }

    loadDonor();
  }, []);

  const handleLogin = async (token: string) => {
    setLoading(true);
    try {
      await startSession(token);
    } catch {
      setDonor(null);
      setError('Invalid or expired link. Paste the newest magic link from your donation email.');
      setLoading(false);
      return;
    }
    loadDonor();
  };

  const handleLogout = async () => {
    await endSession();
    setDonor(null);
    navigate('/');
  };

  if (loading) return <LoadingSpinner />;
  if (!donor) return <WalletLogin message={error} onLogin={handleLogin} />;

  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-4xl uppercase">my wallet</h1>
        <button
          onClick={handleLogout}
          className="font-data font-bold text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
        >
          logout
        </button>
      </div>
      <Card className="mb-6">
        <div className="flex justify-between gap-4">
          <div>
            <p className="font-data text-sm text-off-white/55">logged in as</p>
            <p className="font-body font-medium break-all text-off-white">{donor.email}</p>
            {hasModeratorAccess(donor.role) && (
              <p className="font-data text-xs text-d-yellow mt-1">moderator access enabled</p>
            )}
          </div>
          <div className="text-right">
            <p className="font-data text-sm text-off-white/55">available balance</p>
            <p className="font-display text-3xl text-d-yellow">{fmt(donor.balance_remaining)}</p>
          </div>
        </div>
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
          <div className="flex gap-8">
            <div>
              <p className="font-data text-sm text-off-white/55">total donated</p>
              <p className="font-data font-bold text-off-white">{fmt(donor.total_donated)}</p>
            </div>
          </div>
        </div>
      </Card>

      <h2 className="font-display text-3xl uppercase mb-3">donation history</h2>
      {donor.donations.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No donations yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {donor.donations.map((d) => (
            <Card key={d.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{fmt(d.amount_cents)}</p>
                {d.comment && <p className="font-body text-sm text-off-white/55">{d.comment}</p>}
              </div>
              <p className="font-data text-sm text-off-white/55">
                {new Date(d.created_at).toLocaleDateString()}
              </p>
            </Card>
          ))}
        </div>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my claims</h2>
      {donor.reward_claims.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No reward claims yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {donor.reward_claims.map((c) => (
            <Card key={c.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{c.reward.title}</p>
                <p className="font-data text-sm text-off-white/55">{fmt(c.reward.cost_cents)}</p>
              </div>
              <span
                className={`font-data text-xs font-bold px-2 py-1 rounded-sm ${c.status === 'FULFILLED' ? 'text-green' : 'text-d-yellow'}`}
                style={{
                  background:
                    c.status === 'FULFILLED' ? 'rgba(92,189,125,.16)' : 'rgba(208,152,70,.16)',
                }}
              >
                {c.status}
              </span>
            </Card>
          ))}
        </div>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my write-ins</h2>
      {donor.custom_entries.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No write-in options submitted yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {donor.custom_entries.map((e) => (
            <Card key={e.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">"{e.label}"</p>
                <p className="font-data text-sm text-off-white/55">{e.poll.title}</p>
              </div>
              <StatusBadge status={e.status} />
            </Card>
          ))}
        </div>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my poll votes</h2>
      {donor.poll_votes.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No poll votes yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {donor.poll_votes.map((v) => (
            <Card key={v.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{v.poll_option.label}</p>
                <p className="font-data text-sm text-off-white/55">
                  {v.poll.title} · {fmt(v.amount_cents)}
                </p>
              </div>
              <StatusBadge status={v.reversed_at ? 'REVERSED' : 'ACTIVE'} />
            </Card>
          ))}
        </div>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my goal contributions</h2>
      {donor.fund_contributions.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No goal contributions yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {donor.fund_contributions.map((c) => (
            <Card key={c.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{c.goal.title}</p>
                <p className="font-data text-sm text-off-white/55">{fmt(c.amount_cents)}</p>
              </div>
              <StatusBadge status={c.reversed_at ? 'REVERSED' : 'ACTIVE'} />
            </Card>
          ))}
        </div>
      )}

      {(donor.auction_offers ?? []).length > 0 && (
        <>
          <h2 className="font-display text-3xl uppercase mb-3">pay for your win</h2>
          <div className="space-y-2 mb-6">
            {(donor.auction_offers ?? []).map((o) => (
              <Card key={o.id} className="flex justify-between items-center">
                <div>
                  <p className="font-data font-bold text-off-white">{o.auction.title}</p>
                  <p className="font-data text-sm text-off-white/55">
                    {fmt(o.amount_cents)} · pay by {new Date(o.expires_at).toLocaleString()}
                  </p>
                </div>
                {o.checkout_url && (
                  <a href={o.checkout_url} className="btrl-button">
                    pay now
                  </a>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my bids</h2>
      {(donor.bids ?? []).length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No auction bids yet.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {(donor.bids ?? []).map((b) => (
            <Card key={b.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{b.auction.title}</p>
                <p className="font-data text-sm text-off-white/55">{fmt(b.amount_cents)}</p>
              </div>
              <StatusBadge status={b.status} />
            </Card>
          ))}
        </div>
      )}

      <h2 className="font-display text-3xl uppercase mb-3">my auction wins</h2>
      {(donor.auction_wins ?? []).length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No auction wins yet.</p>
      ) : (
        <div className="space-y-2">
          {(donor.auction_wins ?? []).map((w) => (
            <Card key={w.id} className="flex justify-between items-center">
              <div>
                <p className="font-data font-bold text-off-white">{w.auction.title}</p>
                <p className="font-data text-sm text-off-white/55">{fmt(w.winning_bid_cents)}</p>
              </div>
              <StatusBadge status={w.status} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { color: string; background: string }> = {
    FULFILLED: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
    ACTIVE: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
    APPROVED: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
    PENDING: { color: 'var(--d-yellow)', background: 'rgba(208,152,70,.16)' },
    PENDING_APPROVAL: { color: 'var(--d-yellow)', background: 'rgba(208,152,70,.16)' },
    REJECTED: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
    REVERSED: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
  };
  const style = styles[status] || {
    color: 'var(--off-white)',
    background: 'rgba(239,238,236,.08)',
  };
  return (
    <span
      className="font-data text-xs font-bold px-2 py-1 rounded-sm"
      style={{ color: style.color, background: style.background }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
