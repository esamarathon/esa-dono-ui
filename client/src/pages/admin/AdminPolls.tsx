import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage, type Poll } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface PollForm {
  id?: string;
  title: string;
  description: string;
  is_active: boolean;
  ends_at: string;
  allow_custom_entries: boolean;
  max_entry_chars: number | string;
  auto_approve: boolean;
}

const EMPTY: PollForm = {
  title: '',
  description: '',
  is_active: true,
  ends_at: '',
  allow_custom_entries: false,
  max_entry_chars: '',
  auto_approve: true,
};

type PollModal = 'create' | Poll | null;

export default function AdminPolls() {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<PollModal>(null);
  const [form, setForm] = useState<PollForm>(EMPTY);
  const [newOption, setNewOption] = useState('');
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/polls').then((r) => setPolls(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (p: Poll) => {
    setForm({
      ...p,
      ends_at: p.ends_at ? p.ends_at.slice(0, 16) : '',
      max_entry_chars: p.max_entry_chars ?? '',
    } as PollForm);
    setModal(p);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    try {
      const data = {
        ...form,
        ends_at: form.ends_at || null,
        max_entry_chars: form.max_entry_chars ? parseInt(String(form.max_entry_chars)) : null,
        allow_custom_entries: form.allow_custom_entries || false,
      };
      if (modal === 'create') {
        await adminClient.post('/polls', data);
      } else if (modal) {
        await adminClient.put(`/polls/${modal.id}`, data);
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete poll?')) return;
    await adminClient.delete(`/polls/${id}`);
    await reload();
  };

  const addOption = async (pollId: string) => {
    if (!newOption.trim()) return;
    await adminClient.post(`/polls/${pollId}/options`, { label: newOption.trim() });
    setNewOption('');
    await reload();
  };

  const deleteOption = async (id: string) => {
    await adminClient.delete(`/polls/options/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl lowercase">polls</h1>
        <button onClick={openCreate} className="btrl-button">
          + new poll
        </button>
      </div>

      <div className="space-y-4">
        {polls.map((poll) => (
          <Card key={poll.id}>
            <div className="flex justify-between">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{poll.title}</h2>
                {poll.description && (
                  <p className="font-body text-sm text-off-white/55">{poll.description}</p>
                )}
                <p className="font-data text-xs text-off-white/55">
                  total votes: {fmt(poll.total_votes_cents)}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => openEdit(poll)}
                  className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                <button
                  onClick={() => handleDelete(poll.id)}
                  className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                  style={{ color: 'var(--red)' }}
                >
                  delete
                </button>
              </div>
            </div>
            <div className="mt-3 space-y-1">
              {poll.options.map((opt) => (
                <div
                  key={opt.id}
                  className="flex justify-between items-center text-sm px-2 py-1 rounded-sm"
                  style={{ background: 'rgba(239,238,236,.03)' }}
                >
                  <span className="font-data text-off-white">
                    {opt.label} ({fmt(opt.votes_cents)})
                  </span>
                  <button
                    onClick={() => deleteOption(opt.id)}
                    className="font-mono text-[10px] hover:underline"
                    style={{ color: 'var(--red)' }}
                  >
                    remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2 mt-2">
                <input
                  className="flex-1 px-2 py-1 text-sm"
                  placeholder="New option..."
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addOption(poll.id)}
                />
                <button
                  onClick={() => addOption(poll.id)}
                  className="btrl-button btrl-button-ghost text-sm"
                >
                  add
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {modal && (
        <Modal title={modal === 'create' ? 'new poll' : 'edit poll'} onClose={() => setModal(null)}>
          {(
            [
              { key: 'title', label: 'Title' },
              { key: 'description', label: 'Description' },
            ] as { key: keyof PollForm; label: string }[]
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
              ends at (optional)
            </label>
            <input
              type="datetime-local"
              className="w-full px-3 py-2 text-sm"
              value={form.ends_at ?? ''}
              onChange={(e) => setForm((d) => ({ ...d, ends_at: e.target.value }))}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="poll_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="poll_active" className="font-data text-sm text-off-white">
              active
            </label>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="poll_custom"
              checked={form.allow_custom_entries || false}
              onChange={(e) => setForm((d) => ({ ...d, allow_custom_entries: e.target.checked }))}
            />
            <label htmlFor="poll_custom" className="font-data text-sm text-off-white">
              allow custom entries
            </label>
          </div>
          {form.allow_custom_entries && (
            <div className="mb-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="poll_auto_approve"
                checked={form.auto_approve ?? true}
                onChange={(e) => setForm((d) => ({ ...d, auto_approve: e.target.checked }))}
              />
              <label htmlFor="poll_auto_approve" className="font-data text-sm text-off-white">
                auto-approve write-ins (off = review before funds count)
              </label>
            </div>
          )}
          {form.allow_custom_entries && (
            <div className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                max entry characters (optional)
              </label>
              <input
                type="number"
                className="w-full px-3 py-2 text-sm"
                value={form.max_entry_chars ?? ''}
                onChange={(e) => setForm((d) => ({ ...d, max_entry_chars: e.target.value }))}
                placeholder="No limit"
              />
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
