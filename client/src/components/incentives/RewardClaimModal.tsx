import { useState, type ReactNode } from 'react';
import Modal from '../Modal';
import { CLAIM_ANSWER_MAX_CHARS } from '@dono/shared';
import { claimFieldsFor } from '../../lib/rewardClaimFields';

/**
 * Shared claim-answer modal for the reward card and the Pool-credit spend UI.
 * A blank required answer shows an inline "answer required" error (working
 * label, #80) and stages nothing: the modal stays open.
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
      setError('answer required');
      return;
    }
    onSubmit(formData);
  };
  return (
    <Modal title={`add: ${reward.title}`} onClose={onClose}>
      {intro}
      {fields.map((f) => (
        <div className="mb-3" key={f.key}>
          <label
            htmlFor={`claim-${f.key}`}
            className="block font-data font-bold text-sm mb-1 text-off-white"
          >
            {f.label}{' '}
            {!f.required && <span className="text-off-white/40 font-normal">(optional)</span>}
          </label>
          <input
            id={`claim-${f.key}`}
            className="w-full px-3 py-2 text-sm"
            maxLength={f.capped ? CLAIM_ANSWER_MAX_CHARS : undefined}
            value={formData[f.key] || ''}
            onChange={(e) => {
              setError('');
              setFormData((d) => ({ ...d, [f.key]: e.target.value }));
            }}
          />
          {f.capped && (
            <div className="text-xs text-off-white/40 mt-1">
              {(formData[f.key] || '').length}/{CLAIM_ANSWER_MAX_CHARS} characters
            </div>
          )}
          {error && f.required && (
            <p role="alert" className="text-sm mt-1" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btrl-button btrl-button-outline">
          cancel
        </button>
        <button onClick={submit} className="btrl-button">
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}
