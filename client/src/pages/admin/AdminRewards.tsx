import { useEffect, useRef, useState } from 'react';
import adminClient, { uploadRewardImage } from '../../api/admin';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import { apiErrorMessage, type Reward, type Channel } from '../../types';

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
  cost_dollars: '1.00',
  quantity_total: '',
  is_active: true,
  custom_type_label: '',
  image_url: null,
  channel_id: null,
};

type RewardModal = 'create' | Reward | null;

export default function AdminRewards() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<RewardModal>(null);
  const [form, setForm] = useState<RewardForm>(EMPTY);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => adminClient.get('/rewards').then((r) => setRewards(r.data));
  useEffect(() => {
    Promise.all([reload(), adminClient.get('/events').then((r) => setChannels(r.data))]).finally(
      () => setLoading(false),
    );
  }, []);

  const channelName = (id: string | null | undefined) =>
    id ? (channels.find((s) => s.id === id)?.name ?? 'unknown channel') : 'shared';

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
      const url = await uploadRewardImage(file);
      setForm((d) => ({ ...d, image_url: url }));
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
    try {
      await adminClient.delete(`/rewards/${id}`);
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

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'rgba(239,238,236,.03)' }}>
              {['', 'title', 'type', 'cost', 'qty', 'event', 'active', 'actions'].map((h) => (
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
                <td className="px-4 py-2">
                  {r.image_url && (
                    <img
                      src={r.image_url}
                      alt={r.title}
                      className="w-10 h-10 object-cover rounded-sm"
                    />
                  )}
                </td>
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
                <td className="px-4 py-2 font-data text-off-white/55">
                  {channelName(r.channel_id)}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge active={r.is_active} />
                </td>
                <td className="px-4 py-2 flex gap-2">
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
              { key: 'cost_dollars', label: 'Cost (dollars)', type: 'number', step: '0.01' },
              { key: 'quantity_total', label: 'Quantity (blank=unlimited)', type: 'number' },
              { key: 'custom_type_label', label: 'Custom Label (CUSTOM type)', type: 'text' },
            ] as { key: keyof RewardForm; label: string; type: string; step?: string }[]
          ).map((f) => (
            <div key={f.key} className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                {f.label}
              </label>
              <input
                type={f.type}
                step={f.step}
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
            <button onClick={handleSave} disabled={uploading} className="btrl-button">
              save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
