import { useEffect, useState } from 'react';
import {
  getDestinations,
  createDestination,
  updateDestination,
  rotateDestinationSecret,
  deleteDestination,
  getDestinationDeliveries,
  testDestination,
} from '../../api/admin';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import { apiErrorMessage } from '../../types';

const WEBHOOK_EVENT_TYPES = [
  'donation.created',
  'donation.moderated',
  'incentive.created',
  'incentive.enabled',
  'incentive.disabled',
  'incentive.value_changed',
] as const;

type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  is_active: boolean;
  event_types: string[];
  verify_ssl: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
  destination_type: 'HTTP' | 'RABBITMQ';
  amqp_url: string | null;
  amqp_exchange: string;
  amqp_routing_key: string | null;
}

interface WebhookDelivery {
  id: string;
  seq: number;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WebhookForm {
  destination_type: 'HTTP' | 'RABBITMQ';
  url: string;
  secret: string;
  event_types: WebhookEventType[];
  verify_ssl: boolean;
  description: string;
  amqp_url: string;
  amqp_exchange: string;
  amqp_routing_key: string;
}

const EMPTY_FORM: WebhookForm = {
  destination_type: 'HTTP',
  url: '',
  secret: '',
  event_types: [],
  verify_ssl: true,
  description: '',
  amqp_url: '',
  amqp_exchange: '',
  amqp_routing_key: '',
};

export default function AdminWebhooks() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<WebhookEndpoint | 'create' | null>(null);
  const [form, setForm] = useState<WebhookForm>(EMPTY_FORM);
  const [secretVisible, setSecretVisible] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [, setTestLoading] = useState(false);

  const reload = () => getDestinations().then((r) => setEndpoints(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const loadDeliveries = async (id: string) => {
    setDeliveriesLoading(true);
    try {
      const r = await getDestinationDeliveries(id);
      setDeliveries(r.data.deliveries);
    } finally {
      setDeliveriesLoading(false);
    }
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setSecretVisible(false);
    setError('');
    setModal('create');
  };

  const openEdit = (ep: WebhookEndpoint) => {
    setForm({
      destination_type: ep.destination_type,
      url: ep.url,
      secret: ep.secret,
      event_types: ep.event_types as WebhookEventType[],
      verify_ssl: ep.verify_ssl,
      description: ep.description ?? '',
      amqp_url: ep.amqp_url ?? '',
      amqp_exchange: ep.amqp_exchange ?? '',
      amqp_routing_key: ep.amqp_routing_key ?? '',
    });
    setSecretVisible(false);
    setError('');
    setModal(ep);
  };

  const toggleEventType = (t: WebhookEventType) => {
    setForm((f) => ({
      ...f,
      event_types: f.event_types.includes(t)
        ? f.event_types.filter((x) => x !== t)
        : [...f.event_types, t],
    }));
  };

  const handleSave = async () => {
    setError('');
    try {
      if (modal === 'create') {
        await createDestination({
          destination_type: form.destination_type,
          url: form.url || undefined,
          secret: form.secret || undefined,
          event_types: form.event_types,
          verify_ssl: form.verify_ssl,
          description: form.description || undefined,
          amqp_url: form.amqp_url || undefined,
          amqp_exchange: form.amqp_exchange || undefined,
          amqp_routing_key: form.amqp_routing_key || undefined,
        });
      } else if (modal) {
        await updateDestination(modal.id, {
          destination_type: form.destination_type,
          url: form.url || undefined,
          event_types: form.event_types,
          verify_ssl: form.verify_ssl,
          description: form.description || undefined,
          amqp_url: form.amqp_url || undefined,
          amqp_exchange: form.amqp_exchange || undefined,
          amqp_routing_key: form.amqp_routing_key || undefined,
        });
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const handleRotate = async (id: string) => {
    if (!confirm('Rotate the secret? The old secret will stop working immediately.')) return;
    try {
      await rotateDestinationSecret(id);
      await reload();
    } catch (e) {
      alert(apiErrorMessage(e, 'Rotate failed'));
    }
  };

  const handleToggleActive = async (ep: WebhookEndpoint) => {
    try {
      await updateDestination(ep.id, { is_active: !ep.is_active });
      await reload();
    } catch (e) {
      alert(apiErrorMessage(e, 'Update failed'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this webhook endpoint? This cannot be undone.')) return;
    try {
      await deleteDestination(id);
      await reload();
    } catch (e) {
      alert(apiErrorMessage(e, 'Delete failed'));
    }
  };

  const handleTest = async (id: string) => {
    setTestLoading(true);
    try {
      await testDestination(id);
      alert('Test ping queued. Check the delivery log in a few seconds.');
    } catch (e) {
      alert(apiErrorMessage(e, 'Test failed'));
    } finally {
      setTestLoading(false);
    }
  };

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      loadDeliveries(id);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">webhooks</h1>
        <button onClick={openCreate} className="btrl-button">
          + new endpoint
        </button>
      </div>

      {endpoints.length === 0 && (
        <p className="text-off-white/55 font-data text-sm">
          No webhook endpoints configured. Create one to start receiving events.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'rgba(239,238,236,.03)' }}>
              {['type', 'events', 'ssl', 'active', 'actions'].map((h) => (
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
            {endpoints.map((ep) => (
              <>
                <tr key={ep.id} style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}>
                  <td className="px-4 py-2">
                    <span className="font-mono text-[10px] uppercase text-off-white/70">
                      {ep.destination_type === 'RABBITMQ'
                        ? `MQ ${ep.amqp_routing_key ?? ''}`
                        : 'HTTP'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {ep.event_types.map((t) => (
                        <span
                          key={t}
                          className="font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-sm"
                          style={{ background: 'rgba(115,78,158,.3)', color: 'var(--off-white)' }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-off-white/55">
                    {ep.verify_ssl ? 'yes' : 'no'}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge active={ep.is_active} />
                  </td>
                  <td className="px-4 py-2 flex gap-2 flex-wrap">
                    <button
                      onClick={() => openEdit(ep)}
                      className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => handleRotate(ep.id)}
                      className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                    >
                      rotate
                    </button>
                    <button
                      onClick={() => handleToggleActive(ep)}
                      className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                    >
                      {ep.is_active ? 'pause' : 'resume'}
                    </button>
                    <button
                      onClick={() => handleTest(ep.id)}
                      className="font-mono text-[10px] tracking-wider uppercase text-d-yellow hover:text-off-white"
                    >
                      test
                    </button>
                    <button
                      onClick={() => handleExpand(ep.id)}
                      className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                    >
                      {expandedId === ep.id ? 'hide log' : 'log'}
                    </button>
                    <button
                      onClick={() => handleDelete(ep.id)}
                      className="font-mono text-[10px] tracking-wider uppercase hover:text-off-white"
                      style={{ color: 'var(--red)' }}
                    >
                      delete
                    </button>
                  </td>
                </tr>
                {expandedId === ep.id && (
                  <tr>
                    <td colSpan={5} className="px-4 py-3" style={{ background: 'rgba(0,0,0,.2)' }}>
                      {deliveriesLoading ? (
                        <p className="text-off-white/55 text-sm font-data">Loading...</p>
                      ) : deliveries.length === 0 ? (
                        <p className="text-off-white/55 text-sm font-data">No deliveries yet.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead>
                            <tr>
                              {[
                                'seq',
                                'event',
                                'status',
                                'attempts',
                                'last code',
                                'last error',
                              ].map((h) => (
                                <th
                                  key={h}
                                  className="text-left px-2 py-1 font-mono text-off-white/55 uppercase"
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {deliveries.map((d) => (
                              <tr
                                key={d.id}
                                style={{ borderTop: '1px solid rgba(239,238,236,.05)' }}
                              >
                                <td className="px-2 py-1 font-data text-off-white">{d.seq}</td>
                                <td className="px-2 py-1 font-mono text-off-white/55">
                                  {d.event_type}
                                </td>
                                <td className="px-2 py-1">
                                  <span
                                    className="font-mono text-[10px] uppercase"
                                    style={{
                                      color:
                                        d.status === 'SUCCESS'
                                          ? 'var(--green)'
                                          : d.status === 'FAILED'
                                            ? 'var(--red)'
                                            : 'var(--off-white)',
                                    }}
                                  >
                                    {d.status}
                                  </span>
                                </td>
                                <td className="px-2 py-1 font-data text-off-white/55">
                                  {d.attempts}/{d.max_attempts}
                                </td>
                                <td className="px-2 py-1 font-data text-off-white/55">
                                  {d.last_status_code ?? '—'}
                                </td>
                                <td className="px-2 py-1 font-data text-off-white/55 max-w-xs truncate">
                                  {d.last_error ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new webhook endpoint' : 'edit webhook endpoint'}
          onClose={() => setModal(null)}
        >
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-2 text-off-white">
              Destination type
            </label>
            <select
              className="w-full px-3 py-2 text-sm"
              value={form.destination_type}
              onChange={(e) =>
                setForm((f) => ({ ...f, destination_type: e.target.value as 'HTTP' | 'RABBITMQ' }))
              }
            >
              <option value="HTTP">HTTP</option>
              <option value="RABBITMQ">RabbitMQ</option>
            </select>
          </div>

          {form.destination_type === 'HTTP' ? (
            <div className="mb-3">
              <label className="block font-data font-bold text-sm mb-1 text-off-white">URL *</label>
              <input
                type="url"
                className="w-full px-3 py-2 text-sm"
                placeholder="https://example.com/webhook"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            </div>
          ) : (
            <>
              <div className="mb-3">
                <label className="block font-data font-bold text-sm mb-1 text-off-white">
                  AMQP URL *
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm font-mono"
                  placeholder="amqps://user:pass@rabbitmq.example.com:5671/vhost"
                  value={form.amqp_url}
                  onChange={(e) => setForm((f) => ({ ...f, amqp_url: e.target.value }))}
                />
                <p className="text-xs text-off-white/40 mt-1">
                  Credentials embedded in URL, stored in DB.
                </p>
              </div>
              <div className="mb-3">
                <label className="block font-data font-bold text-sm mb-1 text-off-white">
                  Exchange
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm"
                  placeholder="(default exchange)"
                  value={form.amqp_exchange}
                  onChange={(e) => setForm((f) => ({ ...f, amqp_exchange: e.target.value }))}
                />
              </div>
              <div className="mb-3">
                <label className="block font-data font-bold text-sm mb-1 text-off-white">
                  Routing key *
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm"
                  placeholder="my.queue.name"
                  value={form.amqp_routing_key}
                  onChange={(e) => setForm((f) => ({ ...f, amqp_routing_key: e.target.value }))}
                />
              </div>
            </>
          )}

          {form.destination_type === 'HTTP' && (
            <>
              <div className="mb-3">
                <label className="flex items-center gap-2 font-data text-sm text-off-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.verify_ssl}
                    onChange={(e) => setForm((f) => ({ ...f, verify_ssl: e.target.checked }))}
                  />
                  Verify SSL certificate
                </label>
                <p className="text-xs text-off-white/40 mt-1">
                  Disable only if using a self-signed certificate in development.
                </p>
              </div>
              <div className="mb-3">
                <label className="block font-data font-bold text-sm mb-2 text-off-white">
                  Secret
                  {modal !== 'create' && (
                    <span className="font-normal text-off-white/40 ml-2">
                      (leave blank to keep current)
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <input
                    type={secretVisible ? 'text' : 'password'}
                    className="flex-1 px-3 py-2 text-sm font-mono"
                    placeholder={
                      modal === 'create' ? '(auto-generated if blank)' : '(current secret)'
                    }
                    value={form.secret}
                    onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setSecretVisible((v) => !v)}
                    className="btrl-button-outline text-xs"
                  >
                    {secretVisible ? 'hide' : 'show'}
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-2 text-off-white">
              Event types *
            </label>
            <div className="grid grid-cols-2 gap-2">
              {WEBHOOK_EVENT_TYPES.map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-2 font-data text-sm text-off-white cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={form.event_types.includes(t)}
                    onChange={() => toggleEventType(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              Description
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 text-sm"
              placeholder="Optional note for this endpoint"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {error && (
            <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={() => setModal(null)} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button
              onClick={handleSave}
              className="btrl-button"
              disabled={form.event_types.length === 0}
            >
              save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
