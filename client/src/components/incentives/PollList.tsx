import { useEffect, useRef, useState } from 'react';
import Card from '../Card';
import Modal from '../Modal';
import ProgressBar from '../ProgressBar';
import AddRemoveButton from '../AddRemoveButton';
import LoadingSpinner from '../LoadingSpinner';
import ShareLinkButton from '../ShareLinkButton';
import { useCart } from '../../context/CartContext';
import { sanitizeMoneyInput } from '../../utils/money';
import {
  CART_SYNC_DEBOUNCE_MS,
  DEFAULT_VOTE_AMOUNT,
  MIN_SPEND_CENTS,
  MIN_SPEND_DOLLARS,
} from '../../config';
import type { Poll, PollOption } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PollList() {
  const {
    polls,
    loading,
    cart,
    addToCart,
    removeFromCart,
    markVisited,
    stalePollIds,
    staleOptionIds,
  } = useCart();

  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [writingIn, setWritingIn] = useState<Poll | null>(null);
  const [writeInLabel, setWriteInLabel] = useState('');
  const [writeInAmount, setWriteInAmount] = useState(DEFAULT_VOTE_AMOUNT);
  const [writeInError, setWriteInError] = useState('');
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    markVisited('polls');
  }, [markVisited]);

  // Debounce syncing an edited amount to an already-in-cart option: firing
  // addToCart on every keystroke caused the cart drawer to re-render on
  // every digit typed. Wait for a short pause in typing instead.
  const cartSyncTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = cartSyncTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  if (loading) return <LoadingSpinner />;

  const getAmount = (pollId: string, optionId: string) => {
    const key = `${pollId}-${optionId}`;
    return amounts[key] ?? DEFAULT_VOTE_AMOUNT;
  };

  const inCart = (pollId: string, optionId: string) =>
    cart.some((i) => i.kind === 'POLL_VOTE' && i.target_id === optionId && i.poll_id === pollId);

  // Donation-impact preview (#52): if this option already has a pending cart
  // amount, show what its bar would look like once that vote is cast. Both
  // numerator and denominator grow by the pending amount (the vote adds to
  // this option's total *and* the poll's total_votes_cents), so recompute
  // the percentage with both adjusted rather than just overlaying the raw
  // cents onto the existing percentage.
  const previewPctFor = (poll: Poll, opt: PollOption) => {
    const item = cart.find(
      (i) => i.kind === 'POLL_VOTE' && i.target_id === opt.id && i.poll_id === poll.id,
    );
    if (!item) return undefined;
    const newValue = opt.votes_cents + item.amount_cents;
    const newMax = (poll.total_votes_cents || 1) + item.amount_cents;
    return (newValue / newMax) * 100;
  };

  const writeInInCart = (pollId: string) =>
    cart.find((i) => i.kind === 'POLL_CUSTOM' && i.poll_id === pollId);

  const handleAdd = (poll: Poll, option: PollOption) => {
    const key = `${poll.id}-${option.id}`;
    const cents = Math.round(parseFloat(amounts[key] ?? DEFAULT_VOTE_AMOUNT) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) return;
    addToCart({
      kind: 'POLL_VOTE',
      target_id: option.id,
      poll_id: poll.id,
      amount_cents: cents,
      label: option.label,
    });
    setFlashKey(key);
    setTimeout(() => setFlashKey((k) => (k === key ? null : k)), 300);
  };

  const syncCartAmount = (poll: Poll, option: PollOption, value: string) => {
    const cents = Math.round(parseFloat(value) * 100);
    if (!isNaN(cents) && cents >= MIN_SPEND_CENTS) {
      addToCart({
        kind: 'POLL_VOTE',
        target_id: option.id,
        poll_id: poll.id,
        amount_cents: cents,
        label: option.label,
      });
    }
  };

  const handleAmountChange = (poll: Poll, option: PollOption, value: string) => {
    const key = `${poll.id}-${option.id}`;
    const sanitized = sanitizeMoneyInput(value);
    setAmounts((a) => ({ ...a, [key]: sanitized }));

    if (!inCart(poll.id, option.id)) return;

    if (cartSyncTimers.current[key]) {
      clearTimeout(cartSyncTimers.current[key]);
    }
    cartSyncTimers.current[key] = setTimeout(() => {
      delete cartSyncTimers.current[key];
      syncCartAmount(poll, option, sanitized);
    }, CART_SYNC_DEBOUNCE_MS);
  };

  const handleAmountBlur = (poll: Poll, option: PollOption) => {
    const key = `${poll.id}-${option.id}`;

    if (cartSyncTimers.current[key]) {
      clearTimeout(cartSyncTimers.current[key]);
      delete cartSyncTimers.current[key];
      if (inCart(poll.id, option.id)) {
        syncCartAmount(poll, option, amounts[key] ?? DEFAULT_VOTE_AMOUNT);
      }
    }

    if (!amounts[key] || !amounts[key].trim()) {
      setAmounts((a) => ({ ...a, [key]: DEFAULT_VOTE_AMOUNT }));
    }
  };

  const openWriteIn = (poll: Poll) => {
    setWritingIn(poll);
    setWriteInLabel('');
    setWriteInAmount(DEFAULT_VOTE_AMOUNT);
    setWriteInError('');
  };

  // Re-hydrates the draft from the cart item so an already-added write-in can
  // be edited instead of forcing remove-then-re-add (#44). Regular vote
  // amounts re-sync on every render via getAmount()/the cart; a write-in's
  // draft state only lived in this component's local state, so without this
  // it silently went stale/uneditable once added.
  const openWriteInEdit = (poll: Poll, item: { amount_cents: number; label?: string }) => {
    setWritingIn(poll);
    setWriteInLabel(item.label ?? '');
    setWriteInAmount((item.amount_cents / 100).toFixed(2));
    setWriteInError('');
  };

  const handleWriteIn = () => {
    setWriteInError('');
    if (!writeInLabel.trim()) {
      setWriteInError('Please enter your option');
      return;
    }
    const cents = Math.round(parseFloat(writeInAmount) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
      setWriteInError(`Minimum amount is $${MIN_SPEND_DOLLARS.toFixed(2)}`);
      return;
    }
    addToCart({
      kind: 'POLL_CUSTOM',
      target_id: writingIn!.id,
      poll_id: writingIn!.id,
      amount_cents: cents,
      label: writeInLabel.trim(),
      data: { label: writeInLabel.trim() },
    });
    setWritingIn(null);
  };

  return (
    <div>
      <h2 className="font-display text-3xl uppercase text-off-white mb-2">vote in polls</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Add votes to your cart. $1 = 1 vote. Votes are cast when you check out.
      </p>
      {polls.map((poll) => {
        const writeIn = writeInInCart(poll.id);
        const pollUnavailable = stalePollIds.has(poll.id);
        return (
          <Card
            key={poll.id}
            id={`poll-${poll.id}`}
            className={`mb-4 ${pollUnavailable ? 'opacity-50' : ''}`}
          >
            <div className="flex justify-between items-start mb-1">
              <h3 className="font-data font-bold text-lg text-off-white">{poll.title}</h3>
              <ShareLinkButton path={`/polls?poll=${poll.id}`} />
            </div>
            {poll.description && (
              <p className="font-body text-sm text-off-white/55 mb-3">{poll.description}</p>
            )}
            {pollUnavailable && (
              <span
                className="inline-block font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm mb-3"
                style={{ background: 'rgba(224,90,90,.2)', color: 'var(--red)' }}
              >
                no longer available
              </span>
            )}
            <div className="space-y-3">
              {poll.options.map((opt) => {
                const added = inCart(poll.id, opt.id);
                const optionUnavailable = staleOptionIds.has(opt.id);
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
                      <ProgressBar
                        value={opt.votes_cents}
                        max={poll.total_votes_cents || 1}
                        previewPct={previewPctFor(poll, opt)}
                      />
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        step="0.01"
                        min={MIN_SPEND_DOLLARS}
                        className="w-20 px-2 py-1 text-sm"
                        value={getAmount(poll.id, opt.id)}
                        onChange={(e) => handleAmountChange(poll, opt, e.target.value)}
                        onBlur={() => handleAmountBlur(poll, opt)}
                        disabled={optionUnavailable}
                      />
                      <AddRemoveButton
                        added={added}
                        onAdd={() => handleAdd(poll, opt)}
                        onRemove={() => removeFromCart('POLL_VOTE', opt.id)}
                        disabled={optionUnavailable}
                        flash={flashKey === `${poll.id}-${opt.id}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {poll.allow_custom_entries && (
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                {writeIn ? (
                  <div className="flex justify-between items-center text-sm">
                    <div>
                      <span className="font-data font-bold text-off-white">
                        your option: "{writeIn.label}"
                      </span>
                      <span className="font-data text-off-white/55 ml-2">
                        {fmt(writeIn.amount_cents)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openWriteInEdit(poll, writeIn)}
                        className="btrl-button btrl-button-ghost text-sm"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => removeFromCart('POLL_CUSTOM', writeIn.target_id)}
                        className="btrl-button btrl-button-outline text-sm"
                      >
                        remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => openWriteIn(poll)}
                    className="btrl-button btrl-button-ghost text-sm"
                  >
                    + add your own option
                  </button>
                )}
              </div>
            )}
          </Card>
        );
      })}
      {polls.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active polls.</p>
      )}

      {writingIn && (
        <Modal
          title={writeInInCart(writingIn.id) ? 'edit your option' : 'add your own option'}
          onClose={() => setWritingIn(null)}
        >
          <p className="font-body text-sm text-off-white/55 mb-3">
            Poll: <strong className="text-off-white">{writingIn.title}</strong>
          </p>
          <p className="font-body text-xs text-off-white/55 mb-3">
            This option will be added to your cart and submitted with your donation.{' '}
            {writingIn.auto_approve === false
              ? 'A moderator reviews new options before they go live; if rejected, the amount is refunded to your wallet.'
              : 'It goes live immediately once your donation completes (subject to moderator review afterward).'}
          </p>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              your option
            </label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="Type your option..."
              value={writeInLabel}
              onChange={(e) => setWriteInLabel(e.target.value)}
              maxLength={writingIn.max_entry_chars || undefined}
            />
            {writingIn.max_entry_chars && (
              <p className="font-mono text-xs text-off-white/55 mt-1">
                {writeInLabel.length}/{writingIn.max_entry_chars} characters
              </p>
            )}
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              amount ($1 minimum)
            </label>
            <input
              type="number"
              step="0.01"
              min={MIN_SPEND_DOLLARS}
              className="w-full px-3 py-2 text-sm"
              value={writeInAmount}
              onChange={(e) => setWriteInAmount(sanitizeMoneyInput(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && handleWriteIn()}
            />
          </div>
          {writeInError && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {writeInError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setWritingIn(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleWriteIn} className="btrl-button">
              {writeInInCart(writingIn.id) ? 'save changes' : 'add to cart'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
