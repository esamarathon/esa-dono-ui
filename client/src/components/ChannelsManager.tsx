import { useCallback, useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import Card from './Card';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import StatusBadge from './StatusBadge';
import ShareLinkButton from './ShareLinkButton';
import { apiErrorMessage, type Channel, type Event } from '../types';

interface ChannelForm {
  id?: string;
  name: string;
  slug: string;
  event_id: string;
  is_active: boolean;
}

const EMPTY: ChannelForm = { name: '', slug: '', event_id: '', is_active: true };

const SLUG_HELP =
  'Changing a slug breaks overlay bindings and published links, so it is blocked while active.';

type ChannelModal = 'create' | Channel | null;

/**
 * Channel management, shared by the admin and moderator pages (same API under
 * `/api/admin` and `/api/moderator`, see server routes/identityRoutes.ts).
 */
export default function ChannelsManager({ client }: { client: AxiosInstance }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ChannelModal>(null);
  const [form, setForm] = useState<ChannelForm>(EMPTY);
  const [error, setError] = useState('');

  const reload = useCallback(
    () =>
      Promise.all([
        client.get('/channels').then((r) => setChannels(r.data)),
        client.get('/events').then((r) => setEvents(r.data)),
      ]).then(() => undefined),
    [client],
  );
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, [reload]);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (s: Channel) => {
    setForm({ id: s.id, name: s.name, slug: s.slug, event_id: s.event_id, is_active: s.is_active });
    setModal(s);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    const payload = {
      name: form.name,
      ...(form.slug ? { slug: form.slug } : {}),
      ...(form.event_id ? { event_id: form.event_id } : {}),
      is_active: form.is_active,
    };
    try {
      if (modal === 'create') await client.post('/channels', payload);
      else if (modal) await client.put(`/channels/${modal.id}`, payload);
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this channel? Existing incentives/donations keep referencing it.'))
      return;
    await client.delete(`/channels/${id}`);
    await reload();
  };

  const eventName = (id: string) => events.find((e) => e.id === id)?.name ?? '—';

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">channels</h1>
        <button onClick={openCreate} className="btrl-button">
          + new channel
        </button>
      </div>

      <p className="font-body text-sm text-off-white/55 mb-6">
        Every donation is routed to exactly one channel. Rewards, polls, and fund goals can be tied
        to a specific channel or left shared (available to any channel). Deactivating a channel
        hides it from the /donate picker without deleting its history.
      </p>

      <div className="space-y-3">
        {channels.map((s) => (
          <Card key={s.id}>
            <div className="flex justify-between items-center">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{s.name}</h2>
                <p className="font-mono text-xs text-off-white/55 mt-1">
                  slug: {s.slug} &middot; event: {eventName(s.event_id)}
                </p>
                <div className="mt-2">
                  <StatusBadge active={s.is_active} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ShareLinkButton path={`/donate?channel=${s.id}`} />
                <button
                  onClick={() => openEdit(s)}
                  className="font-mono text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                {s.is_active && (
                  <button
                    onClick={() => handleDeactivate(s.id)}
                    className="font-mono text-sm tracking-wider uppercase hover:text-off-white"
                    style={{ color: 'var(--red)' }}
                  >
                    deactivate
                  </button>
                )}
              </div>
            </div>
          </Card>
        ))}
        {channels.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No channels yet.</p>
        )}
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new channel' : 'edit channel'}
          onClose={() => setModal(null)}
        >
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">name</label>
            <input
              className="w-full px-3 py-2 text-sm"
              value={form.name}
              onChange={(e) => setForm((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">slug</label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="derived from the name"
              disabled={modal !== 'create' && modal.is_active}
              value={form.slug}
              onChange={(e) => setForm((d) => ({ ...d, slug: e.target.value }))}
            />
            <p className="font-body text-sm text-off-white/55 mt-1">{SLUG_HELP}</p>
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">event</label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.event_id}
              onChange={(e) => setForm((d) => ({ ...d, event_id: e.target.value }))}
            >
              {modal === 'create' && (
                <option value="">— the only event (required if there are several) —</option>
              )}
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="channel_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="channel_active" className="font-data text-sm text-off-white">
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
