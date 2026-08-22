import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import EventPill from '../../components/EventPill';
import { useModeratorEventFilter } from '../../context/ModeratorEventFilterContext';
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
  event_id: string | null;
}

const EMPTY: RewardForm = {
  title: '',
  description: '',
  type: 'DIGITAL',
  cost_cents: '',
  quantity_total: '',
  is_active: true,
  custom_type_label: '',
  event_id: null,
};

type RewardModal = 'create' | Reward | null;

export default function ModeratorRewards() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<RewardModal>(null);
  const [form, setForm] = useState<RewardForm>(EMPTY);
  const [error, setError] = useState('');
  const { events, selectedEventId } = useModeratorEventFilter();

  const reload = () => moderatorClient.get('/rewards').then((r) => setRewards(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const eventName = (id: string | null | undefined) =>
    id ? (events.find((s) => s.id === id)?.name ?? 'unknown event') : 'shared';

  const filteredRewards = rewards.filter(
    (r) => !selectedEventId || r.event_id === selectedEventId || r.event_id == null,
  );

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (r: Reward) => {
    setForm({
      ...r,
      cost_cents: String(r.cost_cents),
      quantity_total: r.quantity_total ?? '',
      event_id: r.event_id ?? null,
    } as RewardForm);
    setModal(r);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    const data = {
      ...form,
      cost_cents: parseInt(String(form.cost_cents)),
      quantity_total: form.quantity_total ? parseInt(String(form.quantity_total)) : null,
    };
    try {
      if (modal === 'create') await moderatorClient.post('/rewards', data);
      else if (modal) await moderatorClient.put(`/rewards/${modal.id}`, data);
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete reward?')) return;
    try {
      await moderatorClient.delete(`/rewards/${id}`);
      await reload();
    } catch (e) {
      alert(apiErrorMessage(e, 'Delete failed'));
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">rewards</h1>
        <button onClick={openCreate} className="btrl-button">
          + new reward
        </button>
      </div>

      <div className="space-y-4">
        {filteredRewards.map((r) => (
          <Card key={r.id}>
            <div className="flex justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-data font-bold text-lg text-off-white">{r.title}</h2>
                  <EventPill label={eventName(r.event_id)} />
                </div>
                <p className="font-data text-sm text-off-white/55">
                  {r.type} &middot; {fmt(r.cost_cents)}
                </p>
                {r.quantity_total && (
                  <p className="font-data text-xs text-off-white/55">
                    {r.quantity_claimed}/{r.quantity_total} claimed
                  </p>
                )}
                <div className="mt-2">
                  <StatusBadge active={r.is_active} />
                </div>
              </div>
              <div className="flex gap-2">
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
              </div>
            </div>
          </Card>
        ))}
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new reward' : 'edit reward'}
          onClose={() => setModal(null)}
        >
          {(
            [
              { key: 'title', label: 'Title' },
              { key: 'description', label: 'Description' },
            ] as { key: keyof RewardForm; label: string }[]
          ).map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
              </label>
              <input
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
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {form.type === 'CUSTOM' && (
            <div className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                custom type label
              </label>
              <input
                className="w-full px-3 py-2 text-sm"
                value={form.custom_type_label ?? ''}
                onChange={(e) => setForm((d) => ({ ...d, custom_type_label: e.target.value }))}
              />
            </div>
          )}
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              cost (cents)
            </label>
            <input
              type="number"
              className="w-full px-3 py-2 text-sm"
              value={form.cost_cents}
              onChange={(e) => setForm((d) => ({ ...d, cost_cents: e.target.value }))}
            />
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              quantity total (blank = unlimited)
            </label>
            <input
              type="number"
              className="w-full px-3 py-2 text-sm"
              value={form.quantity_total ?? ''}
              onChange={(e) => setForm((d) => ({ ...d, quantity_total: e.target.value }))}
            />
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">event</label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.event_id ?? ''}
              onChange={(e) => setForm((d) => ({ ...d, event_id: e.target.value || null }))}
            >
              <option value="">shared (any event)</option>
              {events.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="modreward_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="modreward_active" className="font-data text-sm text-off-white">
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
