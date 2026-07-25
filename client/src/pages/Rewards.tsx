import { useEffect, useState } from 'react';
import { getRewards, claimReward } from '../api/rewards';
import LoadingSpinner from '../components/LoadingSpinner';
import Card from '../components/Card';
import Modal from '../components/Modal';
import { apiErrorMessage, type Reward } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface FieldDef {
  key: string;
  label: string;
  required: boolean;
}

const FIELDS: Record<string, FieldDef[]> = {
  PHYSICAL: [
    { key: 'name', label: 'Full Name', required: true },
    { key: 'address', label: 'Address', required: true },
    { key: 'city', label: 'City', required: true },
    { key: 'country', label: 'Country', required: true },
  ],
  SHOUTOUT: [{ key: 'message', label: 'Shoutout Message', required: false }],
  DIGITAL: [],
};

export default function Rewards() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Reward | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    getRewards()
      .then(setRewards)
      .finally(() => setLoading(false));
  }, []);

  const openClaim = (reward: Reward) => {
    setSelected(reward);
    setFormData({});
    setError('');
    setSuccess('');
  };

  const handleClaim = async () => {
    setError('');
    try {
      await claimReward(selected!.id, formData);
      setSuccess('Reward claimed successfully!');
      setTimeout(() => {
        setSelected(null);
        setSuccess('');
      }, 2000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to claim reward.'));
    }
  };

  const fields: FieldDef[] = selected
    ? (FIELDS[selected.type] ?? [
        { key: 'data', label: selected.custom_type_label ?? 'Additional Info', required: false },
      ])
    : [];

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="font-display text-4xl lowercase mb-6">rewards</h1>
      {!localStorage.getItem('donor_token') && (
        <div
          className="p-3 mb-4 rounded-sm text-sm"
          style={{ background: 'rgba(208,152,70,.16)', color: 'var(--d-yellow)' }}
        >
          Visit your wallet link from email to claim rewards.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rewards.map((r) => (
          <Card key={r.id}>
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <h3 className="font-data font-bold text-lg text-off-white">{r.title}</h3>
                {r.description && (
                  <p className="font-body text-sm text-off-white/55 mt-1">{r.description}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <span
                    className="font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm"
                    style={{ background: 'rgba(115,78,158,.3)', color: 'var(--off-white)' }}
                  >
                    {r.type}
                  </span>
                  {r.quantity_total !== null && (
                    <span
                      className="font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm"
                      style={{
                        background: 'rgba(239,238,236,.08)',
                        color: 'rgba(239,238,236,.55)',
                      }}
                    >
                      {r.quantity_total - r.quantity_claimed} left
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right ml-4">
                <p className="font-display text-2xl text-d-yellow">{fmt(r.cost_cents)}</p>
                <button
                  onClick={() => openClaim(r)}
                  disabled={r.quantity_total !== null && r.quantity_claimed >= r.quantity_total}
                  className="btrl-button mt-2"
                >
                  {r.quantity_total !== null && r.quantity_claimed >= r.quantity_total
                    ? 'sold out'
                    : 'claim'}
                </button>
              </div>
            </div>
          </Card>
        ))}
        {rewards.length === 0 && (
          <p className="font-body text-sm text-off-white/55 col-span-2">No rewards available.</p>
        )}
      </div>

      {selected && (
        <Modal title={`claim: ${selected.title}`} onClose={() => setSelected(null)}>
          {fields.map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
                {f.required && ' *'}
              </label>
              <input
                className="w-full px-3 py-2 text-sm"
                value={formData[f.key] ?? ''}
                onChange={(e) => setFormData((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </div>
          ))}
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
            <button onClick={handleClaim} className="btrl-button">
              claim for {fmt(selected.cost_cents)}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
