import { useEffect, useRef, useState } from 'react';
import Card from '../Card';
import ProgressBar from '../ProgressBar';
import AddRemoveButton from '../AddRemoveButton';
import LoadingSpinner from '../LoadingSpinner';
import ShareLinkButton from '../ShareLinkButton';
import { useCart } from '../../context/CartContext';
import { sanitizeMoneyInput } from '../../utils/money';
import {
  CART_SYNC_DEBOUNCE_MS,
  DEFAULT_GOAL_AMOUNT,
  MIN_SPEND_CENTS,
  MIN_SPEND_DOLLARS,
} from '../../config';
import type { Goal } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function GoalList() {
  const { goals, loading, cart, addToCart, removeFromCart, markVisited, staleGoalIds } = useCart();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    markVisited('goals');
  }, [markVisited]);

  // Debounce syncing an edited amount to an already-in-cart goal — see the
  // matching pattern in PollList for why.
  const cartSyncTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = cartSyncTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  if (loading) return <LoadingSpinner />;

  const getAmount = (goalId: string) => amounts[goalId] ?? DEFAULT_GOAL_AMOUNT;

  const inCart = (id: string) => cart.some((i) => i.kind === 'GOAL' && i.target_id === id);

  // Donation-impact preview (#52): a goal's target is fixed, so a pending
  // cart amount only grows the numerator.
  const previewPctFor = (goal: Goal) => {
    const item = cart.find((i) => i.kind === 'GOAL' && i.target_id === goal.id);
    if (!item) return undefined;
    return ((goal.current_cents + item.amount_cents) / goal.target_cents) * 100;
  };

  const handleAdd = (goal: Goal) => {
    const cents = Math.round(parseFloat(amounts[goal.id] ?? DEFAULT_GOAL_AMOUNT) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) return;
    addToCart({
      kind: 'GOAL',
      target_id: goal.id,
      amount_cents: cents,
      label: goal.title,
    });
    setFlashId(goal.id);
    setTimeout(() => setFlashId((id) => (id === goal.id ? null : id)), 300);
  };

  const syncCartAmount = (goal: Goal, value: string) => {
    const cents = Math.round(parseFloat(value) * 100);
    if (!isNaN(cents) && cents >= MIN_SPEND_CENTS) {
      addToCart({
        kind: 'GOAL',
        target_id: goal.id,
        amount_cents: cents,
        label: goal.title,
      });
    }
  };

  const handleAmountChange = (goal: Goal, value: string) => {
    const sanitized = sanitizeMoneyInput(value);
    setAmounts((a) => ({ ...a, [goal.id]: sanitized }));

    if (!inCart(goal.id)) return;

    if (cartSyncTimers.current[goal.id]) {
      clearTimeout(cartSyncTimers.current[goal.id]);
    }
    cartSyncTimers.current[goal.id] = setTimeout(() => {
      delete cartSyncTimers.current[goal.id];
      syncCartAmount(goal, sanitized);
    }, CART_SYNC_DEBOUNCE_MS);
  };

  const handleAmountBlur = (goal: Goal) => {
    if (cartSyncTimers.current[goal.id]) {
      clearTimeout(cartSyncTimers.current[goal.id]);
      delete cartSyncTimers.current[goal.id];
      if (inCart(goal.id)) {
        syncCartAmount(goal, amounts[goal.id] ?? DEFAULT_GOAL_AMOUNT);
      }
    }

    if (!amounts[goal.id] || !amounts[goal.id]!.trim()) {
      setAmounts((a) => ({ ...a, [goal.id]: DEFAULT_GOAL_AMOUNT }));
    }
  };

  return (
    <div>
      <h2 className="font-display text-3xl uppercase text-off-white mb-2">support fund goals</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Add contributions to your cart. They're applied to fund goals when you check out.
      </p>
      {goals.map((g) => {
        const unavailable = staleGoalIds.has(g.id);
        return (
          <Card key={g.id} className={`mb-4 ${g.is_complete || unavailable ? 'opacity-50' : ''}`}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="font-data font-bold text-lg text-off-white">{g.title}</h3>
                {g.description && (
                  <p className="font-body text-sm text-off-white/55">{g.description}</p>
                )}
                {unavailable && (
                  <span
                    className="inline-block font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm mt-2"
                    style={{ background: 'rgba(224,90,90,.2)', color: 'var(--red)' }}
                  >
                    no longer available
                  </span>
                )}
              </div>
              {!g.is_complete && !unavailable && (
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <input
                    type="number"
                    step="0.01"
                    min={MIN_SPEND_DOLLARS}
                    className="w-20 px-2 py-1 text-sm"
                    value={getAmount(g.id)}
                    onChange={(e) => handleAmountChange(g, e.target.value)}
                    onBlur={() => handleAmountBlur(g)}
                  />
                  <AddRemoveButton
                    added={inCart(g.id)}
                    onAdd={() => handleAdd(g)}
                    onRemove={() => removeFromCart('GOAL', g.id)}
                    flash={flashId === g.id}
                  />
                  <ShareLinkButton path={`/goals?goal=${g.id}`} />
                </div>
              )}
            </div>
            <ProgressBar
              value={g.current_cents}
              max={g.target_cents}
              previewPct={previewPctFor(g)}
            />
            <div className="flex justify-between font-data text-sm text-off-white/55 mt-1">
              <span>{fmt(g.current_cents)} raised</span>
              <span>goal: {fmt(g.target_cents)}</span>
            </div>
          </Card>
        );
      })}
      {goals.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active fund goals.</p>
      )}
    </div>
  );
}
