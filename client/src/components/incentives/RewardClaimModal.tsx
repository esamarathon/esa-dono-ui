import { useState, type ReactNode } from 'react';
import Modal from '../Modal';
import { CLAIM_ANSWER_MAX_CHARS } from '@dono/shared';
import { claimFieldsFor } from '../../lib/rewardClaimFields';

/**
 * Shared claim-answer modal for the reward card and the Pool-credit spend UI.
 * A blank required answer shows an inline "{label} is required." error (#80)
 * and stages nothing: the modal stays open. Every answer is capped at 200
 * characters with a `0 / 200` counter visible from the start (#78/#80).
 */
export default function RewardClaimModal({
  reward,
  intro,
  submitLabel,
  onSubmit,
  onClose,
}: {
  reward: { id: string; title: string; type: string; custom_type_label?: string | null };
  intro: ReactNode;
  submitLabel: string;
  onSubmit: (data: Record<string, string>) => void;
  onClose: () => void;
}) {
  const fields = claimFieldsFor(reward);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const submit = () => {
    const blank = fields.find((f) => f.required && !(formData[f.key] ?? '').trim());
    if (blank) {
      setError(`${blank.label} is required.`);
      return;
    }
    onSubmit(formData);
  };
  return (
    <Modal title={`Add: ${reward.title}`} onClose={onClose}>
      {intro}
      {fields.map((f) => (
        <div className="mb-3" key={f.key}>
          <label
            htmlFor={`claim-${f.key}`}
            className="block font-data font-bold text-sm mb-1 text-off-white"
          >
            {f.label}{' '}
            {!f.required && (
              <span className="text-off-white/40 font-normal">
                (optional; {CLAIM_ANSWER_MAX_CHARS} characters maximum)
              </span>
            )}
          </label>
          <input
            id={`claim-${f.key}`}
            className="w-full px-3 py-2 text-sm"
            maxLength={CLAIM_ANSWER_MAX_CHARS}
            value={formData[f.key] || ''}
            onChange={(e) => {
              setError('');
              setFormData((d) => ({ ...d, [f.key]: e.target.value }));
            }}
          />
          <div className="text-sm text-off-white/40 mt-1">
            {(formData[f.key] || '').length} / {CLAIM_ANSWER_MAX_CHARS}
          </div>
          {error && f.required && (
            <p role="alert" className="text-sm mt-1" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btrl-button btrl-button-outline">
          Cancel
        </button>
        <button onClick={submit} className="btrl-button">
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}
