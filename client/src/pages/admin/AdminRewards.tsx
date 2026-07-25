import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage, type Reward } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface RewardForm {
  id?: string;
  title: string;
  description: string;
  type: string;
  cost_cents: number | string;
  quantity_total: number | string | null;
  is_active: boolean;
  custom_type_label: string;
}

const EMPTY: RewardForm = {
  title: '',
  description: '',
  type: 'DIGITAL',
  cost_cents: 100,
  quantity_total: '',
  is_active: true,
  custom_type_label: '',
};

type RewardModal = 'create' | Reward | null;

export default function AdminRewards() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<RewardModal>(null);
  const [form, setForm] = useState<RewardForm>(EMPTY);
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/rewards').then((r) => setRewards(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (r: Reward) => {
    setForm({
      ...r,
      cost_cents: r.cost_cents,
      quantity_total: r.quantity_total ?? '',
    } as RewardForm);
    setModal(r);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    const data = {
      ...form,
      cost_cents: parseInt(String(form.cost_cents)),
      quantity_total: form.quantity_total === '' ? null : parseInt(String(form.quantity_total)),
    };
    try {
      if (modal === 'create') {
        await adminClient.post('/rewards', data);
      } else if (modal) {
        await adminClient.put(`/rewards/${modal.id}`, data);
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this reward?')) return;
    await adminClient.delete(`/rewards/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl lowercase">rewards</h1>
        <button onClick={openCreate} className="btrl-button">
          + new reward
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'rgba(239,238,236,.03)' }}>
              {['title', 'type', 'cost', 'qty', 'active', 'actions'].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rewards.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                <td className="px-4 py-2 font-data font-bold text-off-white">{r.title}</td>
                <td className="px-4 py-2">
                  <span
                    className="font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm"
                    style={{ background: 'rgba(115,78,158,.3)', color: 'var(--off-white)' }}
                  >
                    {r.type}
                  </span>
                </td>
                <td className="px-4 py-2 font-data text-off-white">{fmt(r.cost_cents)}</td>
                <td className="px-4 py-2 font-data text-off-white/55">
                  {r.quantity_total ?? '∞'} ({r.quantity_claimed} claimed)
                </td>
                <td className="px-4 py-2 font-data text-off-white/55">{r.is_active ? '✓' : '✗'}</td>
                <td className="px-4 py-2 flex gap-2">
                  <button
                    onClick={() => openEdit(r)}
                    className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                    style={{ color: 'var(--red)' }}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new reward' : 'edit reward'}
          onClose={() => setModal(null)}
        >
          {(
            [
              { key: 'title', label: 'Title', type: 'text' },
              { key: 'description', label: 'Description', type: 'text' },
              { key: 'cost_cents', label: 'Cost (cents)', type: 'number' },
              { key: 'quantity_total', label: 'Quantity (blank=unlimited)', type: 'number' },
              { key: 'custom_type_label', label: 'Custom Label (CUSTOM type)', type: 'text' },
            ] as { key: keyof RewardForm; label: string; type: string }[]
          ).map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
              </label>
              <input
                type={f.type}
                className="w-full px-3 py-2 text-sm"
                value={(form[f.key] as string | number | undefined) ?? ''}
                onChange={(e) => setForm((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">type</label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.type}
              onChange={(e) => setForm((d) => ({ ...d, type: e.target.value }))}
            >
              {['DIGITAL', 'PHYSICAL', 'SHOUTOUT', 'CUSTOM'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="is_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="is_active" className="font-data text-sm text-off-white">
              active
            </label>
          </div>
          {error && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setModal(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={handleSave} className="btrl-button">
              save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
