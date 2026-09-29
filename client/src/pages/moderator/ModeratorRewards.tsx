import { useEffect, useRef, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import ChannelPill from '../../components/ChannelPill';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import { apiErrorMessage, type Reward } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

interface RewardForm {
  id?: string;
  title: string;
  description: string;
  type: string;
  cost_dollars: number | string;
  quantity_total: number | string | null;
  is_active: boolean;
  custom_type_label: string;
  image_url: string | null;
  channel_id: string | null;
}

const EMPTY: RewardForm = {
  title: '',
  description: '',
  type: 'DIGITAL',
  cost_dollars: '',
  quantity_total: '',
  is_active: true,
  custom_type_label: '',
  image_url: null,
  channel_id: null,
};

type RewardModal = 'create' | Reward | null;

export default function ModeratorRewards() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<RewardModal>(null);
  const [form, setForm] = useState<RewardForm>(EMPTY);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const { channels, selectedChannelId } = useModeratorChannelFilter();

  const reload = () => moderatorClient.get('/rewards').then((r) => setRewards(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const channelName = (id: string | null | undefined) =>
    id ? (channels.find((s) => s.id === id)?.name ?? 'unknown channel') : 'shared';

  const filteredRewards = rewards.filter(
    (r) => !selectedChannelId || r.channel_id === selectedChannelId || r.channel_id == null,
  );

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
    setUploadError('');
  };
  const openEdit = (r: Reward) => {
    setForm({
      ...r,
      cost_dollars: (r.cost_cents / 100).toFixed(2),
      quantity_total: r.quantity_total ?? '',
      image_url: r.image_url ?? null,
      channel_id: r.channel_id ?? null,
    } as RewardForm);
    setModal(r);
    setError('');
    setUploadError('');
  };

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await moderatorClient.post('/uploads', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setForm((d) => ({ ...d, image_url: data.url as string }));
    } catch (e) {
      setUploadError(apiErrorMessage(e, 'Upload failed'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    setError('');
    const data = {
      ...form,
      cost_cents: Math.round(parseFloat(String(form.cost_dollars)) * 100),
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
              <div className="flex gap-3">
                {r.image_url && (
                  <img
                    src={r.image_url}
                    alt={r.title}
                    className="w-16 h-16 object-cover rounded-sm shrink-0"
                  />
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-data font-bold text-lg text-off-white">{r.title}</h2>
                    <ChannelPill label={channelName(r.channel_id)} />
                  </div>
                  <p className="font-data text-sm text-off-white/55">
                    {r.type} &middot; {fmt(r.cost_cents)}
                  </p>
                  {r.quantity_total && (
                    <p className="font-data text-sm text-off-white/55">
                      {r.quantity_claimed}/{r.quantity_total} claimed
                    </p>
                  )}
                  <div className="mt-2">
                    <StatusBadge active={r.is_active} />
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => openEdit(r)}
                  className="font-mono text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                <button
                  onClick={() => handleDelete(r.id)}
                  className="font-mono text-sm tracking-wider uppercase hover:text-off-white"
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
              cost (dollars)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              className="w-full px-3 py-2 text-sm"
              value={form.cost_dollars}
              onChange={(e) => setForm((d) => ({ ...d, cost_dollars: e.target.value }))}
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
          {/* Image upload */}
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              image{' '}
              <span className="text-off-white/40 font-normal">
                (optional · jpeg/png/webp/gif, max 8 MB)
              </span>
            </label>
            {form.image_url && (
              <div className="flex items-center gap-3 mb-2">
                <img
                  src={form.image_url}
                  alt="preview"
                  className="w-20 h-20 object-cover rounded-sm"
                />
                <button
                  type="button"
                  onClick={() => setForm((d) => ({ ...d, image_url: null }))}
                  className="font-mono text-xs hover:underline"
                  style={{ color: 'var(--red)' }}
                >
                  remove
                </button>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="w-full text-sm text-off-white/70"
              disabled={uploading}
              onChange={handleImageChange}
            />
            {uploading && <p className="font-data text-xs text-off-white/55 mt-1">Uploading…</p>}
            {uploadError && (
              <p className="font-data text-xs mt-1" style={{ color: 'var(--red)' }}>
                {uploadError}
              </p>
            )}
          </div>
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
            <button onClick={handleSave} disabled={uploading} className="btrl-button">
              save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
