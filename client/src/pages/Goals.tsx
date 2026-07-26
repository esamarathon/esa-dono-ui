import { useEffect, useState } from 'react';
import { getGoals, contributeGoal } from '../api/goals';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import Modal from '../components/Modal';
import ProgressBar from '../components/ProgressBar';
import { apiErrorMessage, type Goal } from '../types';
import { sanitizeMoneyInput } from '../utils/money';
import { DEFAULT_GOAL_AMOUNT, MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '../config';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Goals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Goal | null>(null);
  const [amount, setAmount] = useState(DEFAULT_GOAL_AMOUNT);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const reload = () => getGoals().then(setGoals);
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const handleContribute = async () => {
    setError('');
    const cents = Math.round(parseFloat(amount) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
      setError(`Minimum contribution is $${MIN_SPEND_DOLLARS.toFixed(2)}`);
      return;
    }
    try {
      await contributeGoal(selected!.id, cents);
      setSuccess('Contribution made!');
      reload();
      setTimeout(() => {
        setSelected(null);
        setSuccess('');
      }, 1500);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to contribute.'));
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="font-display text-4xl lowercase mb-6">fund goals</h1>
      {goals.map((g) => (
        <Card key={g.id} className="mb-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-data font-bold text-lg text-off-white">{g.title}</h2>
              {g.description && (
                <p className="font-body text-sm text-off-white/55">{g.description}</p>
              )}
            </div>
            {g.is_complete ? (
              <span
                className="font-data text-xs font-bold px-2 py-1 rounded-sm"
                style={{ background: 'rgba(92,189,125,.16)', color: 'var(--green)' }}
              >
                complete!
              </span>
            ) : (
              <button
                onClick={() => {
                  setSelected(g);
                  setAmount(DEFAULT_GOAL_AMOUNT);
                  setError('');
                  setSuccess('');
                }}
                className="btrl-button"
              >
                contribute
              </button>
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

      {selected && (
        <Modal title={`contribute to: ${selected.title}`} onClose={() => setSelected(null)}>
          <p className="font-body text-sm text-off-white/55 mb-3">
            {fmt(selected.current_cents)} / {fmt(selected.target_cents)} raised
          </p>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">amount</label>
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
            <button onClick={() => setSelected(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleContribute} className="btrl-button">
              contribute
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
