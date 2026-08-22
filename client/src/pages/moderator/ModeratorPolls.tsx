import { useEffect, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import ChannelPill from '../../components/ChannelPill';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import { apiErrorMessage, type Poll, type CustomEntry } from '../../types';

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
  channel_id: string | null;
}

const EMPTY: PollForm = {
  title: '',
  description: '',
  is_active: true,
  ends_at: '',
  allow_custom_entries: false,
  max_entry_chars: '',
  auto_approve: true,
  channel_id: null,
};

type PollModal = 'create' | Poll | null;

export default function ModeratorPolls() {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<PollModal>(null);
  const [form, setForm] = useState<PollForm>(EMPTY);
  const [newOption, setNewOption] = useState('');
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [optionDraft, setOptionDraft] = useState('');
  const [error, setError] = useState('');
  const [entriesPanel, setEntriesPanel] = useState<string | null>(null);
  const [entries, setEntries] = useState<CustomEntry[]>([]);
  const { channels, selectedChannelId } = useModeratorChannelFilter();

  const reload = () => moderatorClient.get('/polls').then((r) => setPolls(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const channelName = (id: string | null | undefined) =>
    id ? (channels.find((s) => s.id === id)?.name ?? 'unknown channel') : 'shared';

  const filteredPolls = polls.filter(
    (p) => !selectedChannelId || p.channel_id === selectedChannelId || p.channel_id == null,
  );

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
      channel_id: p.channel_id ?? null,
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
        await moderatorClient.post('/polls', data);
      } else if (modal) {
        await moderatorClient.put(`/polls/${modal.id}`, data);
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete poll?')) return;
    await moderatorClient.delete(`/polls/${id}`);
    await reload();
  };

  const addOption = async (pollId: string) => {
    if (!newOption.trim()) return;
    await moderatorClient.post(`/polls/${pollId}/options`, { label: newOption.trim() });
    setNewOption('');
    await reload();
  };

  const deleteOption = async (id: string) => {
    await moderatorClient.delete(`/polls/options/${id}`);
    await reload();
  };

  const startEditOption = (opt: { id: string; label: string }) => {
    setEditingOptionId(opt.id);
    setOptionDraft(opt.label);
  };

  const saveOption = async (id: string) => {
    if (!optionDraft.trim()) return;
    await moderatorClient.patch(`/polls/options/${id}`, { label: optionDraft.trim() });
    setEditingOptionId(null);
    await reload();
  };

  const loadEntries = async (pollId: string) => {
    const { data } = await moderatorClient.get(`/polls/${pollId}/custom-entries`);
    setEntries(data);
    setEntriesPanel(pollId);
  };

  const handleApproveReject = async (entryId: string, status: string) => {
    await moderatorClient.patch(`/polls/custom-entries/${entryId}`, { status });
    await reload();
    if (entriesPanel) {
      const { data } = await moderatorClient.get(`/polls/${entriesPanel}/custom-entries`);
      setEntries(data);
    }
  };

  const pendingCount = (poll: Poll) =>
    poll.custom_entries?.filter((e) => e.status === 'PENDING').length || 0;

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">polls</h1>
        <button onClick={openCreate} className="btrl-button">
          + new poll
        </button>
      </div>

      <div className="space-y-4">
        {filteredPolls.map((poll) => (
          <Card key={poll.id}>
            <div className="flex justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-data font-bold text-lg text-off-white">{poll.title}</h2>
                  <ChannelPill label={channelName(poll.channel_id)} />
                </div>
                {poll.description && (
                  <p className="font-body text-sm text-off-white/55">{poll.description}</p>
                )}
                <p className="font-data text-xs text-off-white/55">
                  total votes: {fmt(poll.total_votes_cents)}
                  {poll.allow_custom_entries &&
                    ` · custom entries ${poll.auto_approve === false ? '(needs approval)' : '(auto-approved)'}`}
                </p>
                <div className="mt-2">
                  <StatusBadge active={poll.is_active} />
                </div>
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
                  {editingOptionId === opt.id ? (
                    <>
                      <input
                        autoFocus
                        className="flex-1 px-2 py-1 text-sm"
                        value={optionDraft}
                        onChange={(e) => setOptionDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveOption(opt.id);
                          if (e.key === 'Escape') setEditingOptionId(null);
                        }}
                      />
                      <button
                        onClick={() => saveOption(opt.id)}
                        className="ml-2 font-mono text-[10px] hover:underline"
                        style={{ color: 'var(--green)' }}
                      >
                        save
                      </button>
                      <button
                        onClick={() => setEditingOptionId(null)}
                        className="ml-2 font-mono text-[10px] hover:underline text-off-white/55"
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="font-data text-off-white">
                        {opt.label} ({fmt(opt.votes_cents)}){opt.custom_entry_id ? ' · custom' : ''}
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => startEditOption(opt)}
                          className="font-mono text-[10px] hover:underline"
                          style={{ color: 'var(--d-yellow)' }}
                        >
                          edit
                        </button>
                        <button
                          onClick={() => deleteOption(opt.id)}
                          className="font-mono text-[10px] hover:underline"
                          style={{ color: 'var(--red)' }}
                        >
                          remove
                        </button>
                      </div>
                    </>
                  )}
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

            {poll.allow_custom_entries && (
              <button
                onClick={() => loadEntries(poll.id)}
                className="mt-3 font-data text-sm text-d-yellow hover:text-off-white"
              >
                {pendingCount(poll) > 0
                  ? `${pendingCount(poll)} pending entries`
                  : 'custom entries'}
              </button>
            )}

            {entriesPanel === poll.id && (
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-data font-bold text-sm text-off-white">custom entries</h4>
                  <ChannelPill label={channelName(poll.channel_id)} />
                </div>
                {entries.length === 0 ? (
                  <p className="font-body text-xs text-off-white/55">No entries yet.</p>
                ) : (
                  <div className="space-y-2">
                    {entries.map((e) => (
                      <div
                        key={e.id}
                        className="flex justify-between items-center text-sm p-2 rounded-sm"
                        style={{
                          background:
                            e.status === 'PENDING'
                              ? 'rgba(208,152,70,.16)'
                              : e.status === 'APPROVED'
                                ? 'rgba(92,189,125,.16)'
                                : 'rgba(252,28,103,.18)',
                        }}
                      >
                        <div>
                          <span
                            className={`font-data ${e.status === 'REJECTED' ? 'line-through text-off-white/55' : 'text-off-white'}`}
                          >
                            {e.label}
                          </span>
                          {e.option?.votes?.[0] && (
                            <span className="font-data text-xs text-d-yellow ml-2">
                              {fmt(e.option.votes[0].amount_cents)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
                            style={{
                              color:
                                e.status === 'PENDING'
                                  ? 'var(--d-yellow)'
                                  : e.status === 'APPROVED'
                                    ? 'var(--green)'
                                    : 'var(--red)',
                            }}
                          >
                            {e.status}
                          </span>
                          {e.status === 'PENDING' && (
                            <>
                              <button
                                onClick={() => handleApproveReject(e.id, 'APPROVED')}
                                className="font-mono text-[10px] hover:underline"
                                style={{ color: 'var(--green)' }}
                              >
                                approve
                              </button>
                              <button
                                onClick={() => handleApproveReject(e.id, 'REJECTED')}
                                className="font-mono text-[10px] hover:underline"
                                style={{ color: 'var(--red)' }}
                              >
                                reject
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      {modal && (
        <Modal title={modal === 'create' ? 'new poll' : 'edit poll'} onClose={() => setModal(null)}>
          {modal === 'create' && (
            <p className="mb-3 text-sm" style={{ color: 'var(--d-yellow)' }}>
              Poll options are added on the main polls page after the poll is created.
            </p>
          )}
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
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">event</label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.channel_id ?? ''}
              onChange={(e) => setForm((d) => ({ ...d, channel_id: e.target.value || null }))}
            >
              <option value="">shared (any event)</option>
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
              id="modpoll_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="modpoll_active" className="font-data text-sm text-off-white">
              active
            </label>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="modpoll_custom"
              checked={form.allow_custom_entries || false}
              onChange={(e) => setForm((d) => ({ ...d, allow_custom_entries: e.target.checked }))}
            />
            <label htmlFor="modpoll_custom" className="font-data text-sm text-off-white">
              allow custom entries
            </label>
          </div>
          {form.allow_custom_entries && (
            <div className="mb-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="modpoll_auto_approve"
                checked={form.auto_approve ?? true}
                onChange={(e) => setForm((d) => ({ ...d, auto_approve: e.target.checked }))}
              />
              <label htmlFor="modpoll_auto_approve" className="font-data text-sm text-off-white">
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
