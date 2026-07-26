import { useEffect, useState } from 'react';
import { getPolls, votePoll, submitCustomEntry } from '../api/polls';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import Modal from '../components/Modal';
import ProgressBar from '../components/ProgressBar';
import { apiErrorMessage, type Poll, type PollOption } from '../types';
import { sanitizeMoneyInput } from '../utils/money';
import { DEFAULT_VOTE_AMOUNT, MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '../config';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Polls() {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<{ poll: Poll; option: PollOption } | null>(null);
  const [amount, setAmount] = useState(DEFAULT_VOTE_AMOUNT);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [writingIn, setWritingIn] = useState<Poll | null>(null);
  const [writeInLabel, setWriteInLabel] = useState('');
  const [writeInAmount, setWriteInAmount] = useState(DEFAULT_VOTE_AMOUNT);
  const [writeInError, setWriteInError] = useState('');
  const [writeInSuccess, setWriteInSuccess] = useState('');

  const reload = () => getPolls().then(setPolls);
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openVote = (poll: Poll, option: PollOption) => {
    setVoting({ poll, option });
    setAmount(DEFAULT_VOTE_AMOUNT);
    setError('');
    setSuccess('');
  };

  const handleVote = async () => {
    setError('');
    const cents = Math.round(parseFloat(amount) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
      setError(`Minimum vote is $${MIN_SPEND_DOLLARS.toFixed(2)}`);
      return;
    }
    try {
      await votePoll(voting!.poll.id, voting!.option.id, cents);
      setSuccess('Vote cast!');
      reload();
      setTimeout(() => {
        setVoting(null);
        setSuccess('');
      }, 1500);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to cast vote.'));
    }
  };

  const openWriteIn = (poll: Poll) => {
    setWritingIn(poll);
    setWriteInLabel('');
    setWriteInAmount(DEFAULT_VOTE_AMOUNT);
    setWriteInError('');
    setWriteInSuccess('');
  };

  const handleWriteIn = async () => {
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
    try {
      const result = await submitCustomEntry(writingIn!.id, writeInLabel.trim(), cents);
      setWriteInSuccess(
        result.pending_approval
          ? 'Funded! Awaiting moderator approval — refunded automatically if rejected.'
          : "Funded and live! It's now in the tally.",
      );
      reload();
      setTimeout(() => {
        setWritingIn(null);
        setWriteInSuccess('');
      }, 2500);
    } catch (e) {
      setWriteInError(apiErrorMessage(e, 'Failed to submit'));
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="font-display text-4xl lowercase mb-6">polls</h1>
      {polls.map((poll) => (
        <Card key={poll.id} className="mb-4">
          <h2 className="font-data font-bold text-lg text-off-white mb-1">{poll.title}</h2>
          {poll.description && (
            <p className="font-body text-sm text-off-white/55 mb-3">{poll.description}</p>
          )}
          {poll.ends_at && (
            <p className="font-mono text-[10px] tracking-wider uppercase text-off-white/55 mb-2">
              ends: {new Date(poll.ends_at).toLocaleString()}
            </p>
          )}
          <div className="space-y-3">
            {poll.options.map((opt) => (
              <div key={opt.id}>
                <div className="flex justify-between items-center mb-1">
                  <span className="font-data font-bold text-sm text-off-white">{opt.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-data text-sm text-off-white/55">
                      {fmt(opt.votes_cents)}
                    </span>
                    <button onClick={() => openVote(poll, opt)} className="btrl-button text-sm">
                      vote
                    </button>
                  </div>
                </div>
                <ProgressBar value={opt.votes_cents} max={poll.total_votes_cents || 1} />
              </div>
            ))}
            {poll.options.length === 0 && (
              <p className="font-body text-sm text-off-white/55">No options yet.</p>
            )}
          </div>
          <p className="font-data text-xs text-off-white/55 mt-2">
            total votes: {fmt(poll.total_votes_cents)}
          </p>
          {poll.allow_custom_entries && (
            <button
              onClick={() => openWriteIn(poll)}
              className="btrl-button btrl-button-ghost mt-2 text-sm"
            >
              + add your own option
            </button>
          )}
        </Card>
      ))}
      {polls.length === 0 && (
        <p className="font-body text-sm text-off-white/55">No active polls.</p>
      )}

      {voting && (
        <Modal title={`vote: ${voting.option.label}`} onClose={() => setVoting(null)}>
          <p className="font-body text-sm text-off-white/55 mb-3">
            In poll: <strong className="text-off-white">{voting.poll.title}</strong>
          </p>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              amount ($1 = 1 vote)
            </label>
            <input
              type="number"
              step="0.01"
              min={MIN_SPEND_DOLLARS}
              className="w-full px-3 py-2 text-sm"
              value={amount}
              onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
            />
          </div>
          {error && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm mb-2" style={{ color: 'var(--green)' }}>
              {success}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setVoting(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleVote} className="btrl-button">
              cast vote
            </button>
          </div>
        </Modal>
      )}

      {writingIn && (
        <Modal title="add your own option" onClose={() => setWritingIn(null)}>
          <p className="font-body text-sm text-off-white/55 mb-3">
            Poll: <strong className="text-off-white">{writingIn.title}</strong>
          </p>
          <p className="font-body text-xs text-off-white/55 mb-3">
            {writingIn.auto_approve === false
              ? 'Your balance is spent now. A moderator reviews new options before they go live; if rejected, the amount is refunded to your wallet.'
              : 'Your balance is spent now and your option goes live immediately (subject to moderator review afterward).'}
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
          {writeInSuccess && (
            <p className="text-sm mb-2" style={{ color: 'var(--green)' }}>
              {writeInSuccess}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setWritingIn(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleWriteIn} className="btrl-button">
              fund it now
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
