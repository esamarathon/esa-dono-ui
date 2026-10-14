import { useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import Card from './Card';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import StatusBadge from './StatusBadge';
import { apiErrorMessage, type Channel, type Event, type EventEndPreview } from '../types';

interface EventForm {
  id?: string;
  name: string;
  slug: string;
  primary_channel_id: string;
}

const EMPTY: EventForm = { name: '', slug: '', primary_channel_id: '' };

const SLUG_HELP =
  'Changing a slug breaks overlay bindings and published links, so it is blocked while active.';

type EventModal = 'create' | Event | null;

/**
 * Events CRUD, shared by the admin and moderator pages (#115). Both surfaces
 * hit the same identity routes. End/Undo end is an explicit admin capability;
 * the server independently enforces that permission outside the shared routes.
 */
export default function EventsManager({
  client,
  canEndEvents = false,
}: {
  client: AxiosInstance;
  canEndEvents?: boolean;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<EventModal>(null);
  const [form, setForm] = useState<EventForm>(EMPTY);
  const [error, setError] = useState('');
  const [endPreview, setEndPreview] = useState<EventEndPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [endBusy, setEndBusy] = useState(false);

  const previewEnd = async (event: Event) => {
    setError('');
    setConfirmation('');
    setEndBusy(true);
    try {
      const action = event.ended_at ? 'undo-end' : 'end';
      const response = await client.get(`/events/${event.id}/${action}-preview`);
      setEndPreview(response.data);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not preview Event end'));
    } finally {
      setEndBusy(false);
    }
  };
  const applyEnd = async () => {
    if (!endPreview || endBusy) return;
    setError('');
    setEndBusy(true);
    try {
      await client.post(
        `/events/${endPreview.event_id}/${endPreview.action === 'END' ? 'end' : 'undo-end'}`,
        { slug: confirmation },
      );
      await reload();
      setEndPreview(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Event end action failed'));
    } finally {
      setEndBusy(false);
    }
  };

  const reload = () =>
    Promise.all([
      client.get('/events').then((r) => setEvents(r.data)),
      client.get('/channels').then((r) => setChannels(r.data)),
    ]).then(() => undefined);

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
  };
  const openEdit = (s: Event) => {
    setForm({
      id: s.id,
      name: s.name,
      slug: s.slug,
      primary_channel_id: s.primary_channel_id ?? '',
    });
    setModal(s);
    setError('');
  };

  const handleSave = async () => {
    setError('');
    try {
      if (modal === 'create') {
        await client.post('/events', {
          name: form.name,
          ...(form.slug ? { slug: form.slug } : {}),
        });
      } else if (modal) {
        await client.put(`/events/${modal.id}`, {
          name: form.name,
          ...(form.slug ? { slug: form.slug } : {}),
          primary_channel_id: form.primary_channel_id || null,
        });
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const toggleActive = async (event: Event) => {
    setError('');
    try {
      await client.put(`/events/${event.id}`, { is_active: !event.is_active });
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to update event'));
    }
  };

  const eventChannels = (id: string | undefined) => channels.filter((c) => c.event_id === id);
  const channelName = (id: string | null) => channels.find((c) => c.id === id)?.name ?? '—';
  const isActiveModal = modal !== null && modal !== 'create' && modal.is_active;

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
        An event is a charity event (a marathon, or a one-day stream event) that groups channels
        (streams). Donations with no channel are routed to the event's primary channel, so an event
        needs an active primary channel before it can be activated.
      </p>

      {error && !modal && !endPreview && (
        <p className="font-body text-sm mb-3" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div className="space-y-3">
        {events.map((s) => (
          <Card key={s.id}>
            <div className="flex justify-between items-center">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{s.name}</h2>
                <p className="font-mono text-xs text-off-white/55 mt-1">slug: {s.slug}</p>
                <p className="font-data text-xs text-off-white/55 mt-1">
                  primary channel: {channelName(s.primary_channel_id)} &middot;{' '}
                  {eventChannels(s.id).length} channel
                  {eventChannels(s.id).length === 1 ? '' : 's'}
                </p>
                <div className="mt-2">
                  <StatusBadge active={s.is_active} />
                  {s.ended_at && (
                    <span className="font-data text-xs ml-2">
                      ended {new Date(s.ended_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!s.ended_at && (
                  <button
                    onClick={() => toggleActive(s)}
                    className="font-mono text-sm tracking-wider uppercase"
                    style={{ color: s.is_active ? 'var(--red)' : 'var(--green)' }}
                  >
                    {s.is_active ? 'deactivate' : 'activate'}
                  </button>
                )}
                {canEndEvents && !s.is_active && (
                  <button
                    disabled={endBusy}
                    onClick={() => previewEnd(s)}
                    className="btrl-button btrl-button-outline"
                  >
                    {s.ended_at ? 'Undo end' : 'end Event'}
                  </button>
                )}
                <button
                  onClick={() => openEdit(s)}
                  className="font-mono text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
                >
                  edit
                </button>
              </div>
            </div>
          </Card>
        ))}
        {events.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No events yet.</p>
        )}
      </div>

      {endPreview && (
        <Modal
          title={endPreview.action === 'END' ? 'end Event' : 'Undo end'}
          onClose={() => {
            if (!endBusy) setEndPreview(null);
          }}
        >
          <p>
            {endPreview.action === 'END'
              ? 'Poll and goal Pool credit becomes Unused pool money; reward Pool credit expires.'
              : 'Pool credit is restored. The Event stays inactive and the Payment refund window reopens.'}
          </p>
          {(['poll', 'goal', 'reward'] as const).map((category) => (
            <p key={category}>
              {category} Pool credit: ${(endPreview.pool_credit_cents[category] / 100).toFixed(2)}
            </p>
          ))}
          <p>
            {endPreview.unshipped_physical_donations} donations with unshipped physical rewards.{' '}
            {endPreview.action === 'END'
              ? 'Their Payment refund window closes.'
              : 'Their Payment refund window reopens.'}
          </p>
          <p>{endPreview.open_pledges} open Pending pledges</p>
          {endPreview.blockers.map((reason) => (
            <p role="alert" key={reason}>
              {reason}
            </p>
          ))}
          {endPreview.consuming_assignments.map((row) => (
            <p key={`${row.donation_id}-${row.category}`}>
              Donation {row.donation_id}, {row.category}: reverse assignments{' '}
              {row.assignment_ids.join(', ')} first.
            </p>
          ))}
          <label className="block my-4">
            Type {endPreview.slug} to confirm
            <input
              aria-label="Event slug confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="w-full px-3 py-2 text-sm"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button
            disabled={endBusy || !endPreview.can_apply || confirmation !== endPreview.slug}
            onClick={applyEnd}
            className="btrl-button"
          >
            confirm {endPreview.action === 'END' ? 'end Event' : 'Undo end'}
          </button>
        </Modal>
      )}
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
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">slug</label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="derived from the name"
              disabled={isActiveModal}
              value={form.slug}
              onChange={(e) => setForm((d) => ({ ...d, slug: e.target.value }))}
            />
            <p className="font-body text-sm text-off-white/55 mt-1">{SLUG_HELP}</p>
          </div>
          {modal !== 'create' && (
            <div className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                primary channel
              </label>
              <select
                className="w-full px-3 py-2 text-sm"
                value={form.primary_channel_id}
                onChange={(e) => setForm((d) => ({ ...d, primary_channel_id: e.target.value }))}
              >
                <option value="">— none —</option>
                {eventChannels(modal.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="font-body text-sm text-off-white/55 mt-1">
                Donations that name no channel are routed here. It must be an active channel of this
                event before the event can be activated.
              </p>
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
