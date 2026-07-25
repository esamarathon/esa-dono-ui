import { useEffect, useState } from 'react';
import { getPolls, votePoll, submitCustomEntry } from '../api/polls';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import Modal from '../components/Modal';
import ProgressBar from '../components/ProgressBar';
import { apiErrorMessage, type Poll, type PollOption } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Polls() {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<{ poll: Poll; option: PollOption } | null>(null);
  const [amount, setAmount] = useState('1.00');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [suggesting, setSuggesting] = useState<Poll | null>(null);
  const [suggestLabel, setSuggestLabel] = useState('');
  const [suggestError, setSuggestError] = useState('');
  const [suggestSuccess, setSuggestSuccess] = useState('');

  const reload = () => getPolls().then(setPolls);
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openVote = (poll: Poll, option: PollOption) => {
    setVoting({ poll, option });
    setAmount('1.00');
    setError('');
    setSuccess('');
  };

  const handleVote = async () => {
    setError('');
    const cents = Math.round(parseFloat(amount) * 100);
    if (isNaN(cents) || cents < 100) {
      setError('Minimum vote is $1.00');
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

  const openSuggest = (poll: Poll) => {
    setSuggesting(poll);
    setSuggestLabel('');
    setSuggestError('');
    setSuggestSuccess('');
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
              onClick={() => openSuggest(poll)}
              className="btrl-button btrl-button-ghost mt-2 text-sm"
            >
              + suggest an option
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
              min="1"
              className="w-full px-3 py-2 text-sm"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
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
