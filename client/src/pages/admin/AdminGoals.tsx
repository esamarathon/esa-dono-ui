import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import ProgressBar from '../../components/ProgressBar';
import LoadingSpinner from '../../components/LoadingSpinner';
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
  current_cents?: number;
}

const EMPTY: GoalForm = { title: '', description: '', target_cents: 1000, is_active: true };

type GoalModal = 'create' | Goal | null;

export default function AdminGoals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<GoalModal>(null);
  const [form, setForm] = useState<GoalForm>(EMPTY);
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/goals').then((r) => setGoals(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (g: Goal) => {
    setForm({ ...g } as GoalForm);
    setModal(g);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    try {
      const data = { ...form, target_cents: parseInt(String(form.target_cents)) };
      if (modal === 'create') {
        await adminClient.post('/goals', data);
      } else if (modal) {
        await adminClient.put(`/goals/${modal.id}`, data);
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete goal?')) return;
    await adminClient.delete(`/goals/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl lowercase">fund goals</h1>
        <button onClick={openCreate} className="btrl-button">
          + new goal
        </button>
      </div>

      <div className="space-y-4">
        {goals.map((g) => (
          <Card key={g.id}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{g.title}</h2>
                {g.description && (
                  <p className="font-body text-sm text-off-white/55">{g.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {g.is_complete && (
                  <span
                    className="font-data text-xs font-bold px-2 py-0.5 rounded-sm"
                    style={{ background: 'rgba(92,189,125,.16)', color: 'var(--green)' }}
                  >
                    complete
                  </span>
                )}
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
            <ProgressBar value={g.current_cents} max={g.target_cents} />
            <div className="flex justify-between font-data text-sm text-off-white/55 mt-1">
              <span>{fmt(g.current_cents)}</span>
              <span>{fmt(g.target_cents)}</span>
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
              { key: 'target_cents', label: 'Target (cents)', type: 'number' },
            ] as { key: keyof GoalForm; label: string; type?: string }[]
          ).map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
              </label>
              <input
                type={f.type ?? 'text'}
                className="w-full px-3 py-2 text-sm"
                value={(form[f.key] as string | number | undefined) ?? ''}
                onChange={(e) => setForm((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="goal_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="goal_active" className="font-data text-sm text-off-white">
              active
            </label>
          </div>
          {modal !== 'create' && (
            <div className="mb-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="goal_complete"
                checked={form.is_complete ?? false}
                onChange={(e) => setForm((d) => ({ ...d, is_complete: e.target.checked }))}
              />
              <label htmlFor="goal_complete" className="font-data text-sm text-off-white">
                mark complete
              </label>
            </div>
          )}
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
