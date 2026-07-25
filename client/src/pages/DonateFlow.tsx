import { useEffect, useState, useCallback } from 'react';
import { getRewards } from '../api/rewards';
import { getPolls, submitCustomEntry } from '../api/polls';
import { getGoals } from '../api/goals';
import { createPledge } from '../api/pledge';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import ProgressBar from '../components/ProgressBar';
import Modal from '../components/Modal';
import client from '../api/client';
import {
  apiErrorMessage,
  type Reward,
  type Poll,
  type PollOption,
  type Goal,
  type CartItem,
  type PledgeResult,
} from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const STEPS = ['rewards', 'polls', 'goals', 'checkout'];

export default function DonateFlow() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pledgeResult, setPledgeResult] = useState<PledgeResult | null>(null);
  const [donateUrl, setDonateUrl] = useState<string | null>(null);

  useEffect(() => {
    client
      .get('/donate-url')
      .then((r) => setDonateUrl(r.data.url))
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([getRewards(), getPolls(), getGoals()])
      .then(([r, p, g]) => {
        setRewards(r);
        setPolls(p);
        setGoals(g);
      })
      .finally(() => setLoading(false));
  }, []);

  const cartTotal = cart.reduce((sum, item) => sum + item.amount_cents, 0);

  const goNext = useCallback(() => {
    setDirection('next');
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, []);

  const goBack = useCallback(() => {
    setDirection('prev');
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  const addToCart = useCallback((item: CartItem) => {
    setCart((prev) => {
      const idx = prev.findIndex(
        (i) => i.kind === item.kind && i.target_id === item.target_id && i.poll_id === item.poll_id,
      );
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx]!, amount_cents: item.amount_cents, data: item.data };
        return updated;
      }
      return [...prev, item];
    });
  }, []);

  const removeFromCart = useCallback((kind: CartItem['kind'], targetId: string) => {
    setCart((prev) => prev.filter((i) => !(i.kind === kind && i.target_id === targetId)));
  }, []);

  const handleCheckout = async () => {
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await createPledge({
        email: email.trim(),
        items: cart.map((item) => ({
          kind: item.kind,
          target_id: item.target_id,
          amount_cents: item.amount_cents,
          poll_id: item.poll_id,
          data: item.data,
        })),
      });
      setPledgeResult(result);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to create pledge'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  if (pledgeResult) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <Card>
          <h2 className="font-display text-3xl lowercase text-off-white mb-4">
            your pledge is ready
          </h2>
          <p className="font-body text-sm text-off-white/55 mb-4">
            You've selected{' '}
            <strong className="text-d-yellow">{fmt(pledgeResult.total_cents)}</strong> in
            incentives. Anything you donate above this amount will be credited to your wallet as
            spendable balance.
          </p>
          <div className="btrl-panel p-4 mb-4">
            <p className="font-data text-sm text-off-white/55 mb-1">cart total</p>
            <p className="font-display text-4xl text-d-yellow">{fmt(pledgeResult.total_cents)}</p>
          </div>
          <a
            href={pledgeResult.donate_url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="btrl-button block text-center text-lg py-3 mb-3"
            style={{ background: 'var(--d-yellow)', color: 'black' }}
          >
            donate on tiltify
          </a>
          {!pledgeResult.donate_url && (
            <p className="font-body text-xs text-off-white/55">
              No donate URL configured. Contact the event organizer.
            </p>
          )}
          <p className="font-body text-xs text-off-white/55 text-center">
            After donating, your magic link will arrive by email. Your selected incentives will be
            processed automatically.
          </p>
        </Card>
      </div>
    );
  }

  const slideClass = direction === 'next' ? 'animate-slide-in-right' : 'animate-slide-in-left';

  return (
    <div className="max-w-5xl mx-auto p-8">
      {/* Step indicator */}
      <div className="flex justify-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center font-data font-bold text-sm ${
                i <= step ? 'text-black' : 'text-off-white/55'
              }`}
              style={{
                background: i <= step ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)',
              }}
            >
              {i + 1}
            </div>
            <span
              className={`font-data text-sm lowercase hidden sm:inline ${
                i <= step ? 'text-off-white' : 'text-off-white/55'
              }`}
            >
              {s}
            </span>
            {i < STEPS.length - 1 && <span className="text-off-white/55 mx-1">&rarr;</span>}
          </div>
        ))}
      </div>

      <div className="flex gap-8">
        {/* Main content area */}
        <div className="flex-1 min-w-0">
          <div className={`transition-all duration-300 ${slideClass}`}>
            {step === 0 && (
              <RewardsStep
                rewards={rewards}
                cart={cart}
                onAdd={addToCart}
                onRemove={removeFromCart}
              />
            )}
            {step === 1 && (
              <PollsStep polls={polls} cart={cart} onAdd={addToCart} onRemove={removeFromCart} />
            )}
            {step === 2 && (
              <GoalsStep goals={goals} cart={cart} onAdd={addToCart} onRemove={removeFromCart} />
            )}
            {step === 3 && (
              <CheckoutStep
                cart={cart}
                cartTotal={cartTotal}
                email={email}
                onEmailChange={setEmail}
                error={error}
                submitting={submitting}
                onSubmit={handleCheckout}
              />
            )}
          </div>

          {/* Navigation */}
          <div className="flex justify-between items-center mt-8">
            <button
              onClick={goBack}
              disabled={step === 0}
              className="btrl-button btrl-button-outline"
            >
              &larr; back
            </button>
            <div className="flex items-center gap-4">
              {step < STEPS.length - 1 && donateUrl && (
                <a
                  href={donateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-data font-bold text-sm tracking-wider lowercase text-off-white/55 hover:text-off-white no-underline"
                >
                  skip to donation &rarr;
                </a>
              )}
              {step < STEPS.length - 1 ? (
                <button onClick={goNext} disabled={cart.length === 0} className="btrl-button">
                  next &rarr;
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Sticky cart sidebar */}
        <div className="w-72 shrink-0 hidden lg:block">
          <div className="btrl-panel p-4 sticky top-4">
            <h3 className="font-data font-bold text-sm text-off-white mb-3 uppercase tracking-wider">
              your cart
            </h3>
            {cart.length === 0 ? (
              <p className="font-body text-sm text-off-white/55">No items selected yet.</p>
            ) : (
              <div className="space-y-2 mb-4">
                {cart.map((item) => (
                  <div
                    key={`${item.kind}-${item.target_id}`}
                    className="flex justify-between items-start text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-data text-off-white truncate">
                        {item.label || item.kind.toLowerCase()}
                      </p>
                      <p className="font-mono text-[10px] text-off-white/55 uppercase">
                        {item.kind === 'REWARD'
                          ? 'reward'
                          : item.kind === 'POLL_VOTE'
                            ? 'poll vote'
                            : 'goal'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-2">
                      <span className="font-data text-d-yellow">{fmt(item.amount_cents)}</span>
                      <button
                        onClick={() => removeFromCart(item.kind, item.target_id)}
                        className="text-off-white/55 hover:text-red text-xs"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div
              className="flex justify-between font-data font-bold pt-3"
              style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
            >
              <span className="text-off-white">total</span>
              <span className="text-d-yellow">{fmt(cartTotal)}</span>
            </div>
            <p className="font-body text-[10px] text-off-white/55 mt-2">
              You'll donate at least this amount. Anything extra becomes wallet balance.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Step 1: Rewards ─── */
function RewardsStep({
  rewards,
  cart,
  onAdd,
  onRemove,
}: {
  rewards: Reward[];
  cart: CartItem[];
  onAdd: (item: CartItem) => void;
  onRemove: (kind: CartItem['kind'], targetId: string) => void;
}) {
  const [claimData, setClaimData] = useState<Record<string, Record<string, string>>>({});

  const inCart = (id: string) => cart.some((i) => i.kind === 'REWARD' && i.target_id === id);

  const handleAdd = (reward: Reward) => {
    const data = claimData[reward.id] || {};
    onAdd({
      kind: 'REWARD',
      target_id: reward.id,
      amount_cents: reward.cost_cents,
      label: reward.title,
      data,
    });
  };

  return (
    <div>
      <h2 className="font-display text-3xl lowercase text-off-white mb-2">choose rewards</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Select rewards to add to your donation. Each reward costs a fixed amount.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rewards.map((r) => {
          const soldOut = r.quantity_total !== null && r.quantity_claimed >= r.quantity_total;
          return (
            <Card key={r.id} className={soldOut ? 'opacity-50' : ''}>
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h3 className="font-data font-bold text-lg text-off-white">{r.title}</h3>
                  {r.description && (
                    <p className="font-body text-sm text-off-white/55 mt-1">{r.description}</p>
                  )}
                  <span
                    className="inline-block font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm mt-2"
                    style={{ background: 'rgba(115,78,158,.3)', color: 'var(--off-white)' }}
                  >
                    {r.type}
                  </span>
                  {r.quantity_total !== null && (
                    <span className="font-mono text-[10px] text-off-white/55 ml-2">
                      {r.quantity_total - r.quantity_claimed} left
                    </span>
                  )}
                </div>
                <div className="text-right ml-4">
                  <p className="font-display text-2xl text-d-yellow">{fmt(r.cost_cents)}</p>
                  {inCart(r.id) ? (
                    <button
                      onClick={() => onRemove('REWARD', r.id)}
                      className="btrl-button btrl-button-outline mt-2 text-sm"
                    >
                      remove
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAdd(r)}
                      disabled={soldOut}
                      className="btrl-button mt-2 text-sm"
                    >
                      {soldOut ? 'sold out' : 'add'}
                    </button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {rewards.length === 0 && (
          <p className="font-body text-sm text-off-white/55 col-span-2">No rewards available.</p>
        )}
      </div>
    </div>
  );
}

/* ─── Step 2: Polls ─── */
function PollsStep({
  polls,
  cart,
  onAdd,
  onRemove,
}: {
  polls: Poll[];
  cart: CartItem[];
  onAdd: (item: CartItem) => void;
  onRemove: (kind: CartItem['kind'], targetId: string) => void;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [suggesting, setSuggesting] = useState<Poll | null>(null);
  const [suggestLabel, setSuggestLabel] = useState('');
  const [suggestError, setSuggestError] = useState('');
  const [suggestSuccess, setSuggestSuccess] = useState('');

  const getAmount = (pollId: string, optionId: string) => {
    const key = `${pollId}-${optionId}`;
    return amounts[key] || '1.00';
  };

  const inCart = (pollId: string, optionId: string) =>
    cart.some((i) => i.kind === 'POLL_VOTE' && i.target_id === optionId && i.poll_id === pollId);

  const handleAdd = (poll: Poll, option: PollOption) => {
    const key = `${poll.id}-${option.id}`;
    const cents = Math.round(parseFloat(amounts[key] || '1.00') * 100);
    if (isNaN(cents) || cents < 100) return;
    onAdd({
      kind: 'POLL_VOTE',
      target_id: option.id,
      poll_id: poll.id,
      amount_cents: cents,
      label: option.label,
    });
  };

  const handleSuggest = async () => {
    setSuggestError('');
    if (!suggestLabel.trim()) {
      setSuggestError('Please enter a suggestion');
      return;
    }
    try {
      await submitCustomEntry(suggesting!.id, suggestLabel.trim());
      setSuggestSuccess('Submitted for approval!');
      setTimeout(() => {
        setSuggesting(null);
        setSuggestSuccess('');
      }, 2000);
    } catch (e) {
      setSuggestError(apiErrorMessage(e, 'Failed to submit'));
    }
  };

  return (
    <div>
      <h2 className="font-display text-3xl lowercase text-off-white mb-2">vote in polls</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Cast votes in active polls. $1 = 1 vote. Your donation will be split between your vote and
        your other selections.
      </p>
      {polls.map((poll) => (
        <Card key={poll.id} className="mb-4">
          <h3 className="font-data font-bold text-lg text-off-white mb-1">{poll.title}</h3>
          {poll.description && (
            <p className="font-body text-sm text-off-white/55 mb-3">{poll.description}</p>
          )}
          <div className="space-y-3">
            {poll.options.map((opt) => {
              const added = inCart(poll.id, opt.id);
              return (
                <div key={opt.id} className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-data font-bold text-sm text-off-white">
                        {opt.label}
                      </span>
                      <span className="font-data text-sm text-off-white/55">
                        {fmt(opt.votes_cents)}
                      </span>
                    </div>
                    <ProgressBar value={opt.votes_cents} max={poll.total_votes_cents || 1} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      className="w-20 px-2 py-1 text-sm"
                      value={getAmount(poll.id, opt.id)}
                      onChange={(e) =>
                        setAmounts((a) => ({
                          ...a,
                          [`${poll.id}-${opt.id}`]: e.target.value,
                        }))
                      }
                    />
                    {added ? (
                      <button
                        onClick={() => onRemove('POLL_VOTE', opt.id)}
                        className="btrl-button btrl-button-outline text-sm"
                      >
                        remove
                      </button>
                    ) : (
                      <button onClick={() => handleAdd(poll, opt)} className="btrl-button text-sm">
                        add
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {poll.allow_custom_entries && (
            <button
              onClick={() => {
                setSuggesting(poll);
                setSuggestLabel('');
                setSuggestError('');
                setSuggestSuccess('');
              }}
              className="btrl-button btrl-button-ghost mt-3 text-sm"
            >
              + suggest an option
            </button>
          )}
        </Card>
      ))}
      {polls.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active polls.</p>
      )}

      {suggesting && (
        <Modal title="suggest an option" onClose={() => setSuggesting(null)}>
          <p className="font-body text-sm text-off-white/55 mb-3">
            Poll: <strong className="text-off-white">{suggesting.title}</strong>
          </p>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              your suggestion
            </label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="Type your option..."
              value={suggestLabel}
              onChange={(e) => setSuggestLabel(e.target.value)}
              maxLength={suggesting.max_entry_chars || undefined}
              onKeyDown={(e) => e.key === 'Enter' && handleSuggest()}
            />
            {suggesting.max_entry_chars && (
              <p className="font-mono text-xs text-off-white/55 mt-1">
                {suggestLabel.length}/{suggesting.max_entry_chars} characters
              </p>
            )}
          </div>
          {suggestError && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {suggestError}
            </p>
          )}
          {suggestSuccess && (
            <p className="text-sm mb-2" style={{ color: 'var(--green)' }}>
              {suggestSuccess}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setSuggesting(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleSuggest} className="btrl-button">
              submit for approval
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ─── Step 3: Goals ─── */
function GoalsStep({
  goals,
  cart,
  onAdd,
  onRemove,
}: {
  goals: Goal[];
  cart: CartItem[];
  onAdd: (item: CartItem) => void;
  onRemove: (kind: CartItem['kind'], targetId: string) => void;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const inCart = (id: string) => cart.some((i) => i.kind === 'GOAL' && i.target_id === id);

  const handleAdd = (goal: Goal) => {
    const cents = Math.round(parseFloat(amounts[goal.id] || '5.00') * 100);
    if (isNaN(cents) || cents < 100) return;
    onAdd({
      kind: 'GOAL',
      target_id: goal.id,
      amount_cents: cents,
      label: goal.title,
    });
  };

  return (
    <div>
      <h2 className="font-display text-3xl lowercase text-off-white mb-2">support fund goals</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Contribute to fundraising goals. Your donation will be split between your contributions and
        your other selections.
      </p>
      {goals.map((g) => (
        <Card key={g.id} className={`mb-4 ${g.is_complete ? 'opacity-50' : ''}`}>
          <div className="flex justify-between items-start mb-2">
            <div>
              <h3 className="font-data font-bold text-lg text-off-white">{g.title}</h3>
              {g.description && (
                <p className="font-body text-sm text-off-white/55">{g.description}</p>
              )}
            </div>
            {!g.is_complete && (
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  className="w-20 px-2 py-1 text-sm"
                  value={amounts[g.id] || '5.00'}
                  onChange={(e) => setAmounts((a) => ({ ...a, [g.id]: e.target.value }))}
                />
                {inCart(g.id) ? (
                  <button
                    onClick={() => onRemove('GOAL', g.id)}
                    className="btrl-button btrl-button-outline text-sm"
                  >
                    remove
                  </button>
                ) : (
                  <button onClick={() => handleAdd(g)} className="btrl-button text-sm">
                    add
                  </button>
                )}
              </div>
            )}
          </div>
          <ProgressBar value={g.current_cents} max={g.target_cents} />
          <div className="flex justify-between font-data text-sm text-off-white/55 mt-1">
            <span>{fmt(g.current_cents)} raised</span>
            <span>goal: {fmt(g.target_cents)}</span>
          </div>
        </Card>
      ))}
      {goals.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active fund goals.</p>
      )}
    </div>
  );
}

/* ─── Step 4: Checkout ─── */
function CheckoutStep({
  cart,
  cartTotal,
  email,
  onEmailChange,
  error,
  submitting,
  onSubmit,
}: {
  cart: CartItem[];
  cartTotal: number;
  email: string;
  onEmailChange: (value: string) => void;
  error: string;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div>
      <h2 className="font-display text-3xl lowercase text-off-white mb-2">checkout</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Review your selections. You'll donate at least{' '}
        <strong className="text-d-yellow">{fmt(cartTotal)}</strong> on Tiltify. Anything extra will
        be credited to your wallet as spendable balance.
      </p>

      <Card className="mb-4">
        <h3 className="font-data font-bold text-sm text-off-white mb-3 uppercase tracking-wider">
          cart summary
        </h3>
        <div className="space-y-2">
          {cart.map((item) => (
            <div key={`${item.kind}-${item.target_id}`} className="flex justify-between text-sm">
              <span className="font-data text-off-white">{item.label || item.kind}</span>
              <span className="font-data text-d-yellow">{fmt(item.amount_cents)}</span>
            </div>
          ))}
        </div>
        <div
          className="flex justify-between font-data font-bold pt-3 mt-3"
          style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
        >
          <span className="text-off-white">minimum donation</span>
          <span className="text-d-yellow">{fmt(cartTotal)}</span>
        </div>
      </Card>

      <Card className="mb-4">
        <label className="block font-data font-bold text-sm mb-1 text-off-white">
          email address
        </label>
        <p className="font-body text-xs text-off-white/55 mb-2">
          Your magic link and receipt will be sent here. Must match the email you use on Tiltify.
        </p>
        <input
          type="email"
          className="w-full px-3 py-2 text-sm"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
        />
      </Card>

      {error && (
        <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <button
        onClick={onSubmit}
        disabled={submitting || cart.length === 0}
        className="btrl-button w-full text-center text-lg py-3"
        style={{ background: 'var(--d-yellow)', color: 'black' }}
      >
        {submitting ? 'creating pledge...' : `donate at least ${fmt(cartTotal)} on tiltify`}
      </button>
    </div>
  );
}
