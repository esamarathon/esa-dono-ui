import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import ProgressBar from '../../components/ProgressBar';
import StatusBadge from '../../components/StatusBadge';
import EventPill from '../../components/EventPill';
import { useModeratorEventFilter } from '../../context/ModeratorEventFilterContext';
import { apiErrorMessage, type Goal } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface GoalForm {
  id?: string;
  title: string;
  description: string;
  target_cents: number | string;
  is_active: boolean;
  is_complete?: boolean;
  event_id: string | null;
}

const EMPTY: GoalForm = {
  title: '',
  description: '',
  target_cents: '',
  is_active: true,
  event_id: null,
};

type GoalModal = 'create' | Goal | null;

export default function ModeratorGoals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<GoalModal>(null);
  const [form, setForm] = useState<GoalForm>(EMPTY);
  const [error, setError] = useState('');
  const { events, selectedEventId } = useModeratorEventFilter();

  const reload = () => moderatorClient.get('/goals').then((r) => setGoals(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const eventName = (id: string | null | undefined) =>
    id ? (events.find((s) => s.id === id)?.name ?? 'unknown event') : 'shared';

  const filteredGoals = goals.filter(
    (g) => !selectedEventId || g.event_id === selectedEventId || g.event_id == null,
  );

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (g: Goal) => {
    setForm({
      ...g,
      target_cents: String(g.target_cents),
      event_id: g.event_id ?? null,
    } as GoalForm);
    setModal(g);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    const data = { ...form, target_cents: parseInt(String(form.target_cents)) };
    try {
      if (modal === 'create') await moderatorClient.post('/goals', data);
      else if (modal) await moderatorClient.put(`/goals/${modal.id}`, data);
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete goal?')) return;
    await moderatorClient.delete(`/goals/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">fund goals</h1>
        <button onClick={openCreate} className="btrl-button">
          + new goal
        </button>
      </div>

      <div className="space-y-4">
        {filteredGoals.map((g) => (
          <Card key={g.id}>
            <div className="flex justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="font-data font-bold text-lg text-off-white">{g.title}</h2>
                  <EventPill label={eventName(g.event_id)} />
                </div>
                <p className="font-data text-sm text-off-white/55">
                  {fmt(g.current_cents)} / {fmt(g.target_cents)} {g.is_complete && '· complete'}
                </p>
                <div className="mt-2">
                  <StatusBadge active={g.is_active} />
                </div>
                <ProgressBar value={g.current_cents} max={g.target_cents} />
              </div>
              <div className="flex gap-2 ml-4">
                <button
                  onClick={() => openEdit(g)}
                  className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                <button
                  onClick={() => handleDelete(g.id)}
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
        <Modal title={modal === 'create' ? 'new goal' : 'edit goal'} onClose={() => setModal(null)}>
          {(
            [
              { key: 'title', label: 'Title' },
              { key: 'description', label: 'Description' },
            ] as { key: keyof GoalForm; label: string }[]
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
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              target (cents)
            </label>
            <input
              type="number"
              className="w-full px-3 py-2 text-sm"
              value={form.target_cents}
              onChange={(e) => setForm((d) => ({ ...d, target_cents: e.target.value }))}
            />
          </div>
          {modal !== 'create' && (
            <div className="mb-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="modgoal_complete"
                checked={form.is_complete}
                onChange={(e) => setForm((d) => ({ ...d, is_complete: e.target.checked }))}
              />
              <label htmlFor="modgoal_complete" className="font-data text-sm text-off-white">
                complete
              </label>
            </div>
          )}
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
              id="modgoal_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="modgoal_active" className="font-data text-sm text-off-white">
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
