import { useEffect, useMemo, useRef, useState } from 'react';
import Card from '../Card';
import Modal from '../Modal';
import ProgressBar from '../ProgressBar';
import LoadingSpinner from '../LoadingSpinner';
import ShareLinkButton from '../ShareLinkButton';
import { useDraftPledge } from '../../context/DraftPledgeContext';
import { sanitizeMoneyInput } from '../../utils/money';
import { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '../../config';
import { DEFAULT_MAX_ENTRY_CHARS, planPledge, type PledgeSelection } from '@dono/shared';
import type { Poll, PollOption } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * One poll's staged (uncommitted) edits (#76). Staged amounts are ephemeral
 * component state: they are never part of the resumable browser draft, and
 * leaving the polls tab (unmount) discards them. Only "Confirm this poll"
 * writes them to the draft pledge (the cart).
 */
interface PollStaging {
  /** Typed money strings per option id; '' stages a removal of a committed option. */
  amounts: Record<string, string>;
  /** A staged write-in (validated when staged in the modal). */
  writeIn?: { label: string; amount: string };
  /** A staged removal of the committed write-in. */
  writeInRemoval?: boolean;
}

/** Parsed staged cents, or null for empty/unstaged/below-minimum input. */
function stagedCents(raw: string): number | null {
  if (!raw.trim()) return null;
  const cents = Math.round(parseFloat(raw) * 100);
  return isNaN(cents) || cents < MIN_SPEND_CENTS ? null : cents;
}

function amountErrorFor(raw: string): string | null {
  return raw.trim() && stagedCents(raw) === null
    ? `Poll votes start at $${MIN_SPEND_DOLLARS.toFixed(2)}.`
    : null;
}

export default function PollList({
  onStagedChange,
}: {
  onStagedChange?: (staged: boolean) => void;
} = {}) {
  const {
    polls,
    loading,
    selections: cart,
    addSelection: addToCart,
    removeSelection: removeFromCart,
    plan,
    draft,
  } = useDraftPledge();

  const [staging, setStaging] = useState<Record<string, PollStaging>>({});
  const [writingIn, setWritingIn] = useState<Poll | null>(null);
  const [writeInEditing, setWriteInEditing] = useState(false);
  const [writeInLabel, setWriteInLabel] = useState('');
  const [writeInAmount, setWriteInAmount] = useState('');
  const [writeInError, setWriteInError] = useState('');
  const [flashPollId, setFlashPollId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const committedVote = (pollId: string, optionId: string) =>
    cart.find((i) => i.kind === 'POLL_VOTE' && i.target_id === optionId && i.poll_id === pollId);

  const committedWriteIn = (pollId: string) =>
    cart.find((i) => i.kind === 'POLL_CUSTOM' && i.poll_id === pollId);

  /** The row's shown amount: the staged text, else the committed amount, else empty. */
  const displayAmount = (pollId: string, optionId: string) => {
    const raw = staging[pollId]?.amounts[optionId];
    if (raw !== undefined) return raw;
    const item = committedVote(pollId, optionId);
    return item ? (item.amount_cents / 100).toFixed(2) : '';
  };

  /** Staged (or, unstaged, committed) cents for a row; null when none/removal. */
  const effectiveCents = (pollId: string, optionId: string) => {
    const raw = staging[pollId]?.amounts[optionId];
    if (raw !== undefined) return stagedCents(raw);
    return committedVote(pollId, optionId)?.amount_cents ?? null;
  };

  /** Per-poll staging summary: any unsaved edit, and any invalid typed row. */
  const pollChanges = (poll: Poll) => {
    const s = staging[poll.id];
    if (!s) return { dirty: false, hasErrors: false };
    let dirty = false;
    let hasErrors = false;
    for (const [optionId, raw] of Object.entries(s.amounts)) {
      if (amountErrorFor(raw)) {
        hasErrors = true;
        dirty = true;
        continue;
      }
      const committedCents = committedVote(poll.id, optionId)?.amount_cents ?? null;
      if (stagedCents(raw) !== committedCents) dirty = true;
    }
    if (s.writeIn || s.writeInRemoval) dirty = true;
    return { dirty, hasErrors };
  };

  // Donation-impact preview (#52/#157): show what an option's bar would look
  // like once its staged-or-committed amount lands. Both numerator and
  // denominator grow by the pending amounts (the votes add to each option's
  // total *and* the poll's total_votes_cents), so recompute the percentage
  // with both adjusted. The preview models post-confirm reality, so it uses a
  // hypothetical plan built from the staged amounts (auto top-ups included);
  // with nothing staged it is exactly the live plan as before.
  const previewPlan = useMemo(() => {
    const stagedPollIds = Object.entries(staging).filter(
      ([, s]) => Object.keys(s.amounts).length > 0 || s.writeIn || s.writeInRemoval,
    );
    if (!stagedPollIds.length || !draft) return plan;
    try {
      const rows: PledgeSelection[] = [];
      for (const item of cart) {
        const base: PledgeSelection = {
          kind: item.kind,
          target_id: item.target_id,
          poll_id: item.poll_id ?? null,
          amount_cents: item.amount_cents,
          insertion_order: item.insertion_order ?? rows.length,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents ?? null,
          reward_type: item.reward_type ?? null,
          data: item.data,
        };
        const s = item.poll_id ? staging[item.poll_id] : undefined;
        if (item.kind === 'POLL_VOTE' && s && s.amounts[item.target_id] !== undefined) {
          const cents = stagedCents(s.amounts[item.target_id]!);
          if (cents !== null) rows.push({ ...base, amount_cents: cents });
          continue;
        }
        if (item.kind === 'POLL_CUSTOM' && s) {
          if (s.writeInRemoval) continue;
          if (s.writeIn) {
            const cents = stagedCents(s.writeIn.amount);
            if (cents !== null)
              rows.push({ ...base, amount_cents: cents, data: { label: s.writeIn.label } });
            continue;
          }
        }
        rows.push(base);
      }
      let order = rows.reduce((max, r) => Math.max(max, r.insertion_order), -1) + 1;
      for (const [pollId, s] of stagedPollIds) {
        for (const [optionId, raw] of Object.entries(s.amounts)) {
          if (rows.some((r) => r.kind === 'POLL_VOTE' && r.target_id === optionId)) continue;
          const cents = stagedCents(raw);
          if (cents === null) continue;
          rows.push({
            kind: 'POLL_VOTE',
            target_id: optionId,
            poll_id: pollId,
            amount_cents: cents,
            insertion_order: order++,
          });
        }
        if (s.writeIn && !rows.some((r) => r.kind === 'POLL_CUSTOM' && r.poll_id === pollId)) {
          const cents = stagedCents(s.writeIn.amount);
          if (cents !== null)
            rows.push({
              kind: 'POLL_CUSTOM',
              target_id: pollId,
              poll_id: pollId,
              amount_cents: cents,
              insertion_order: order++,
              data: { label: s.writeIn.label },
            });
        }
      }
      return planPledge({
        pledge_amount_cents: draft.amountCents,
        available_wallet_cents: null,
        selections: rows,
      });
    } catch {
      return plan;
    }
  }, [staging, cart, draft, plan]);

  const previewPctFor = (poll: Poll, opt: PollOption) => {
    if (effectiveCents(poll.id, opt.id) === null) return undefined;
    const p = previewPlan;
    if (!p) return undefined;
    const allocation = (id: string) => {
      const index = p.selections.findIndex(
        (i) => i.kind === 'POLL_VOTE' && i.target_id === id && i.poll_id === poll.id,
      );
      return index < 0
        ? 0
        : p.selections[index]!.amount_cents +
            (p.top_up_rows.find((r) => r.selection_index === index)?.amount_cents ?? 0);
    };
    const newValue = opt.votes_cents + allocation(opt.id);
    const newMax =
      poll.total_votes_cents +
      p.selections.reduce((sum, s, index) => {
        if (s.poll_id !== poll.id || (s.kind !== 'POLL_VOTE' && s.kind !== 'POLL_CUSTOM'))
          return sum;
        return (
          sum +
          s.amount_cents +
          (p.top_up_rows.find((r) => r.selection_index === index)?.amount_cents ?? 0)
        );
      }, 0);
    return (newValue / newMax) * 100;
  };

  const handleAmountChange = (poll: Poll, option: PollOption, value: string) => {
    // Staging is local state only: typing never touches the cart, so there is
    // no cart-sync debounce (the old addToCart-on-keystroke re-render problem
    // cannot happen). The poll card re-renders per keystroke, nothing else.
    const sanitized = sanitizeMoneyInput(value);
    setStaging((prev) => ({
      ...prev,
      [poll.id]: {
        ...(prev[poll.id] ?? { amounts: {} }),
        amounts: { ...(prev[poll.id]?.amounts ?? {}), [option.id]: sanitized },
      },
    }));
  };

  /**
   * One commit point per poll (#76): staged adds, edits and removals all land
   * in the draft pledge together, then staging is cleared.
   */
  const confirmPoll = (poll: Poll) => {
    const s = staging[poll.id];
    if (!s) return;
    const changes = pollChanges(poll);
    if (!changes.dirty || changes.hasErrors) return;
    for (const [optionId, raw] of Object.entries(s.amounts)) {
      const committed = committedVote(poll.id, optionId);
      const cents = stagedCents(raw);
      if (cents === null) {
        if (committed && !raw.trim()) removeFromCart('POLL_VOTE', optionId);
        continue;
      }
      if (committed?.amount_cents === cents) continue;
      const option = poll.options.find((o) => o.id === optionId);
      addToCart({
        kind: 'POLL_VOTE',
        target_id: optionId,
        poll_id: poll.id,
        amount_cents: cents,
        label: option?.label,
      });
    }
    const writeIn = s.writeIn;
    if (writeIn) {
      const cents = stagedCents(writeIn.amount);
      if (cents !== null) {
        addToCart({
          kind: 'POLL_CUSTOM',
          target_id: poll.id,
          poll_id: poll.id,
          amount_cents: cents,
          label: writeIn.label,
          data: { label: writeIn.label },
        });
      }
    } else if (s.writeInRemoval && committedWriteIn(poll.id)) {
      removeFromCart('POLL_CUSTOM', poll.id);
    }
    setStaging((prev) => {
      const next = { ...prev };
      delete next[poll.id];
      return next;
    });
    setFlashPollId(poll.id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashPollId((k) => (k === poll.id ? null : k)), 300);
  };

  const openWriteIn = (poll: Poll) => {
    setWritingIn(poll);
    setWriteInEditing(false);
    setWriteInLabel('');
    setWriteInAmount('');
    setWriteInError('');
  };

  // Re-hydrates the modal from the staged-or-committed write-in so an existing
  // entry can be edited instead of forcing remove-then-add (#44). The stage
  // action below only updates local staging; the commit is the per-poll confirm.
  const openWriteInEdit = (poll: Poll, entry: { label: string; cents: number }) => {
    setWritingIn(poll);
    setWriteInEditing(true);
    setWriteInLabel(entry.label);
    setWriteInAmount((entry.cents / 100).toFixed(2));
    setWriteInError('');
  };

  const stageWriteIn = () => {
    setWriteInError('');
    if (!writeInLabel.trim()) {
      setWriteInError('Please enter your option');
      return;
    }
    const maxEntryChars = writingIn!.max_entry_chars ?? DEFAULT_MAX_ENTRY_CHARS;
    if (writeInLabel.length > maxEntryChars) {
      setWriteInError(`Entry exceeds maximum of ${maxEntryChars} characters`);
      return;
    }
    const cents = Math.round(parseFloat(writeInAmount) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
      setWriteInError(`Poll votes start at $${MIN_SPEND_DOLLARS.toFixed(2)}.`);
      return;
    }
    setStaging((prev) => ({
      ...prev,
      [writingIn!.id]: {
        ...(prev[writingIn!.id] ?? { amounts: {} }),
        writeIn: { label: writeInLabel.trim(), amount: writeInAmount },
        writeInRemoval: false,
      },
    }));
    setWritingIn(null);
  };

  const stageWriteInRemoval = (poll: Poll) => {
    setStaging((prev) => {
      const s = prev[poll.id] ?? { amounts: {} };
      if (!committedWriteIn(poll.id)) {
        // Only a staged write-in exists: removing it just clears the staging.
        const next = { ...prev };
        const rest: PollStaging = { amounts: s.amounts };
        if (Object.keys(rest.amounts).length > 0 || rest.writeInRemoval) next[poll.id] = rest;
        else delete next[poll.id];
        return next;
      }
      return {
        ...prev,
        [poll.id]: { amounts: s.amounts, writeInRemoval: true },
      };
    });
    if (writingIn?.id === poll.id) setWritingIn(null);
  };

  // Report staged-edit presence upward (DonateFlow warns at "Review →") and
  // clear it on unmount: leaving the polls tab discards staged edits.
  const anyStaged = polls.some((poll) => pollChanges(poll).dirty);
  useEffect(() => {
    onStagedChange?.(anyStaged);
    return () => onStagedChange?.(false);
  }, [anyStaged, onStagedChange]);

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h2 className="font-display text-3xl uppercase text-off-white mb-2">Vote in polls</h2>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Choose votes from your poll Pool. $1 = 1 vote. Unused amounts top up your selections in
        proportion.
      </p>
      {polls.map((poll) => {
        const s = staging[poll.id];
        const changes = pollChanges(poll);
        const pollUnavailable =
          poll.is_active === false ||
          !!(poll.ends_at && new Date(poll.ends_at).getTime() <= Date.now());
        const committed = committedWriteIn(poll.id);
        const stagedWriteIn = s?.writeIn;
        const shownWriteIn = stagedWriteIn
          ? {
              label: stagedWriteIn.label,
              cents: Math.round(parseFloat(stagedWriteIn.amount) * 100),
            }
          : committed && !s?.writeInRemoval
            ? {
                label:
                  committed.label ?? (committed.data as { label?: string } | null)?.label ?? '',
                cents: committed.amount_cents,
              }
            : null;
        return (
          <Card
            key={poll.id}
            id={`poll-${poll.id}`}
            className={`mb-4 ${pollUnavailable ? 'opacity-50' : ''}`}
          >
            <div className="flex justify-between items-start mb-1">
              <h3 className="font-data font-bold text-lg text-off-white">{poll.title}</h3>
              <ShareLinkButton path={`/polls?poll=${poll.id}`} label="Copy a link to this poll" />
            </div>
            {poll.description && (
              <p className="font-body text-sm text-off-white/55 mb-3">{poll.description}</p>
            )}
            {pollUnavailable && (
              <span
                className="inline-block font-mono text-sm tracking-wider uppercase px-2 py-0.5 rounded-sm mb-3"
                style={{ background: 'rgba(224,90,90,.2)', color: 'var(--red)' }}
              >
                No longer available
              </span>
            )}
            <div className="space-y-3">
              {poll.options.map((opt) => {
                const optionUnavailable = pollUnavailable || opt.status === 'REJECTED';
                const raw = s?.amounts[opt.id];
                const error = raw !== undefined ? amountErrorFor(raw) : null;
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
                    <div className="shrink-0">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`Amount for ${opt.label}`}
                        className={`w-20 px-2 py-1 text-sm ${flashPollId === poll.id ? 'animate-add-flash' : ''}`}
                        value={displayAmount(poll.id, opt.id)}
                        onChange={(e) => handleAmountChange(poll, opt, e.target.value)}
                        disabled={optionUnavailable}
                      />
                      {error && (
                        <p
                          className="font-mono text-sm mt-1 text-right"
                          style={{ color: 'var(--red)' }}
                        >
                          {error}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {poll.allow_custom_entries && !pollUnavailable && (
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                {shownWriteIn ? (
                  <div className="flex justify-between items-center text-sm">
                    <div>
                      <span className="font-data font-bold text-off-white">
                        Your option: "{shownWriteIn.label}"
                      </span>
                      <span className="font-data text-off-white/55 ml-2">
                        {fmt(shownWriteIn.cents)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openWriteInEdit(poll, shownWriteIn)}
                        className="btrl-button btrl-button-ghost text-sm"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => stageWriteInRemoval(poll)}
                        className="btrl-button btrl-button-outline text-sm"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => openWriteIn(poll)}
                    className="btrl-button btrl-button-ghost text-sm"
                  >
                    Add your own option
                  </button>
                )}
              </div>
            )}

            <div
              className="mt-3 pt-3 flex items-center justify-end gap-3"
              style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
            >
              {changes.dirty && (
                <span
                  className="font-mono text-sm uppercase tracking-wider"
                  style={{ color: 'var(--d-yellow)' }}
                >
                  Unsaved changes
                </span>
              )}
              <button
                onClick={() => confirmPoll(poll)}
                disabled={!changes.dirty || changes.hasErrors}
                className="btrl-button"
              >
                Confirm this poll
              </button>
            </div>
          </Card>
        );
      })}
      {polls.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active polls.</p>
      )}

      {writingIn && (
        <Modal
          title={writeInEditing ? 'Edit your option' : 'Add your own option'}
          onClose={() => setWritingIn(null)}
        >
          <p className="font-body text-sm text-off-white/55 mb-3">
            Poll: <strong className="text-off-white">{writingIn.title}</strong>
          </p>
          <p className="font-body text-sm text-off-white/55 mb-3">
            This option will use your poll Pool and be submitted with your donation.{' '}
            {writingIn.auto_approve === false
              ? 'A moderator reviews new options before they go live; if rejected, the amount becomes poll Pool credit.'
              : 'It goes live immediately once your donation completes (subject to moderator review afterward).'}
          </p>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              Your option
            </label>
            <input
              className="w-full px-3 py-2 text-sm"
              value={writeInLabel}
              onChange={(e) => setWriteInLabel(e.target.value)}
              maxLength={writingIn.max_entry_chars ?? DEFAULT_MAX_ENTRY_CHARS}
            />
            <p className="font-mono text-sm text-off-white/55 mt-1">
              {writeInLabel.length}/{writingIn.max_entry_chars ?? DEFAULT_MAX_ENTRY_CHARS}{' '}
              characters
            </p>
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              Amount ($1 minimum)
            </label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              className="w-full px-3 py-2 text-sm"
              value={writeInAmount}
              onChange={(e) => setWriteInAmount(sanitizeMoneyInput(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && stageWriteIn()}
            />
          </div>
          {writeInError && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {writeInError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setWritingIn(null)} className="btrl-button btrl-button-outline">
              Cancel
            </button>
            <button onClick={stageWriteIn} className="btrl-button">
              {writeInEditing ? 'Save changes' : 'Add write-in'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
