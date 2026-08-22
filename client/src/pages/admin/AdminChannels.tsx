import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import { apiErrorMessage, type Channel } from '../../types';

interface EventForm {
  id?: string;
  name: string;
  is_active: boolean;
}

const EMPTY: EventForm = { name: '', is_active: true };

type ChannelModal = 'create' | Channel | null;

export default function AdminChannels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ChannelModal>(null);
  const [form, setForm] = useState<EventForm>(EMPTY);
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/events').then((r) => setChannels(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (s: Channel) => {
    setForm({ ...s });
    setModal(s);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    try {
      if (modal === 'create') await adminClient.post('/events', form);
      else if (modal) await adminClient.put(`/events/${modal.id}`, form);
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this event? Existing incentives/donations keep referencing it.'))
      return;
    await adminClient.delete(`/events/${id}`);
    await reload();
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">events</h1>
        <button onClick={openCreate} className="btrl-button">
          + new event
        </button>
      </div>

      <p className="font-body text-sm text-off-white/55 mb-6">
        Every donation is routed to exactly one event. Rewards, polls, and fund goals can be tied to
        a specific event or left shared (available to any event). Deactivating an event hides it
        from the /donate picker without deleting its history.
      </p>

      <div className="space-y-3">
        {channels.map((s) => (
          <Card key={s.id}>
            <div className="flex justify-between items-center">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{s.name}</h2>
                <div className="mt-2">
                  <StatusBadge active={s.is_active} />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => openEdit(s)}
                  className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
                {s.is_active && (
                  <button
                    onClick={() => handleDeactivate(s.id)}
                    className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
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
          <p className="font-body text-sm text-off-white/55">No events yet.</p>
        )}
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new event' : 'edit event'}
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
          <div className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="event_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="event_active" className="font-data text-sm text-off-white">
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
