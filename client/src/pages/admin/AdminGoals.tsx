import { useEffect, useState } from 'react';
import adminClient, { refundGoal } from '../../api/admin';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import ProgressBar from '../../components/ProgressBar';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import { apiErrorMessage, type Goal, type Channel } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface GoalForm {
  id?: string;
  title: string;
  description: string;
  target_dollars: number | string;
  is_active: boolean;
  is_complete?: boolean;
  current_cents?: number;
  channel_id: string | null;
}

const EMPTY: GoalForm = {
  title: '',
  description: '',
  target_dollars: '10.00',
  is_active: true,
  channel_id: null,
};

type GoalModal = 'create' | Goal | null;

export default function AdminGoals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<GoalModal>(null);
  const [form, setForm] = useState<GoalForm>(EMPTY);
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/goals').then((r) => setGoals(r.data));
  useEffect(() => {
    Promise.all([reload(), adminClient.get('/channels').then((r) => setChannels(r.data))]).finally(
      () => setLoading(false),
    );
  }, []);

  const channelName = (id: string | null | undefined) =>
    id ? (channels.find((s) => s.id === id)?.name ?? 'unknown channel') : 'shared';

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (g: Goal) => {
    setForm({
      ...g,
      target_dollars: (g.target_cents / 100).toFixed(2),
      channel_id: g.channel_id ?? null,
    } as GoalForm);
    setModal(g);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    try {
      const data = {
        ...form,
        target_cents: Math.round(parseFloat(String(form.target_dollars)) * 100),
      };
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
    const goal = goals.find((item) => item.id === id);
    const warning = goal?.current_cents
      ? `This will refund ${fmt(goal.current_cents)} to donor wallets, deactivate the goal, and preserve contribution history. This cannot be undone.`
      : 'This will deactivate the goal and preserve contribution history. This cannot be undone.';
    if (!confirm(`Remove goal?\n\n${warning}`)) return;
    await adminClient.delete(`/goals/${id}`);
    await reload();
  };

  const handleRefund = async (id: string, title: string) => {
    if (
      !confirm(`Refund all contributions to "${title}"? This restores each donor's wallet balance.`)
    )
      return;
    try {
      const result = await refundGoal(id);
      alert(
        `Refunded ${result.refunded_count} contribution(s) totaling ${fmt(result.refunded_cents)}.`,
      );
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Refund failed'));
    }
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
        {goals.map((g) => (
          <Card key={g.id}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{g.title}</h2>
                {g.description && (
                  <p className="font-body text-sm text-off-white/55">{g.description}</p>
                )}
                <p className="font-data text-xs text-off-white/40">
                  channel: {channelName(g.channel_id)}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <StatusBadge active={g.is_active} />
                  {g.is_complete && (
                    <span
                      className="font-data text-xs font-bold px-2 py-0.5 rounded-sm"
                      style={{ background: 'rgba(92,189,125,.16)', color: 'var(--green)' }}
                    >
                      complete
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openEdit(g)}
                  className="font-mono text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                <button
                  onClick={() => handleRefund(g.id, g.title)}
                  className="font-mono text-sm tracking-wider uppercase hover:text-off-white"
                  style={{ color: 'var(--d-yellow)' }}
                >
                  refund contributions
                </button>
                <button
                  onClick={() => handleDelete(g.id)}
                  className="font-mono text-sm tracking-wider uppercase hover:text-off-white"
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
              { key: 'target_dollars', label: 'Target (dollars)', type: 'number', step: '0.01' },
            ] as { key: keyof GoalForm; label: string; type?: string; step?: string }[]
          ).map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
              </label>
              <input
                type={f.type ?? 'text'}
                step={f.step}
                className="w-full px-3 py-2 text-sm"
                value={(form[f.key] as string | number | undefined) ?? ''}
                onChange={(e) => setForm((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">channel</label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.channel_id ?? ''}
              onChange={(e) => setForm((d) => ({ ...d, channel_id: e.target.value || null }))}
            >
              <option value="">shared (any channel)</option>
              {channels.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
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
