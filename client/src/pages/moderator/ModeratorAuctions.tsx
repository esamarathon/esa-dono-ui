import { useEffect, useRef, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import { apiErrorMessage, type Auction, type AuctionBid, type AuctionOffer } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_STYLES: Record<string, { color: string; background: string }> = {
  OPEN: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
  AWAITING_PAYMENT: { color: 'var(--d-yellow)', background: 'rgba(208,152,70,.16)' },
  SENT: { color: 'var(--d-yellow)', background: 'rgba(208,152,70,.16)' },
  PAID: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
  SETTLED: { color: 'var(--green)', background: 'rgba(92,189,125,.16)' },
  EXPIRED: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
  SKIPPED: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
  UNSOLD: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
  CANCELLED: { color: 'var(--red)', background: 'rgba(252,28,103,.18)' },
  CLOSED: { color: 'var(--off-white)', background: 'rgba(239,238,236,.08)' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || {
    color: 'var(--off-white)',
    background: 'rgba(239,238,236,.08)',
  };
  return (
    <span className="font-data text-xs font-bold px-2 py-0.5 rounded-sm" style={style}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

interface AuctionForm {
  id?: string;
  title: string;
  description: string;
  type: string;
  custom_type_label: string;
  image_url: string | null;
  starting_dollars: number | string;
  increment_dollars: number | string;
  ends_at_local: string;
  is_active: boolean;
  channel_id: string | null;
}

const EMPTY: AuctionForm = {
  title: '',
  description: '',
  type: 'PHYSICAL',
  custom_type_label: '',
  image_url: null,
  starting_dollars: '10.00',
  increment_dollars: '5.00',
  ends_at_local: '',
  is_active: true,
  channel_id: null,
};

type AuctionModalState = 'create' | Auction | null;

export default function ModeratorAuctions() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<AuctionModalState>(null);
  const [form, setForm] = useState<AuctionForm>(EMPTY);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [offersFor, setOffersFor] = useState<Auction | null>(null);
  const [offers, setOffers] = useState<AuctionOffer[]>([]);
  const [bidsFor, setBidsFor] = useState<Auction | null>(null);
  const [bids, setBids] = useState<AuctionBid[]>([]);
  const { channels, selectedChannelId } = useModeratorChannelFilter();

  const reload = () => moderatorClient.get('/auctions').then((r) => setAuctions(r.data));
  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const channelName = (id: string | null | undefined) =>
    id ? (channels.find((s) => s.id === id)?.name ?? 'unknown channel') : 'shared';

  const filteredAuctions = auctions.filter(
    (a) => !selectedChannelId || a.channel_id === selectedChannelId || a.channel_id == null,
  );

  const openCreate = () => {
    setForm(EMPTY);
    setModal('create');
    setError('');
    setUploadError('');
  };

  const openEdit = (a: Auction) => {
    setForm({
      ...a,
      custom_type_label: a.custom_type_label ?? '',
      image_url: a.image_url ?? null,
      starting_dollars: (a.starting_price_cents / 100).toFixed(2),
      increment_dollars: (a.min_increment_cents / 100).toFixed(2),
      ends_at_local: toLocalInput(a.ends_at),
      channel_id: a.channel_id ?? null,
    } as AuctionForm);
    setModal(a);
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
      setForm((d) => ({ ...d, image_url: data.url }));
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
      title: form.title,
      description: form.description,
      type: form.type,
      custom_type_label: form.custom_type_label,
      image_url: form.image_url,
      starting_price_cents: Math.round(parseFloat(String(form.starting_dollars)) * 100),
      min_increment_cents: Math.round(parseFloat(String(form.increment_dollars)) * 100),
      ends_at: form.ends_at_local ? new Date(form.ends_at_local).toISOString() : undefined,
      is_active: form.is_active,
      channel_id: form.channel_id,
    };
    try {
      if (modal === 'create') {
        await moderatorClient.post('/auctions', data);
      } else if (modal) {
        await moderatorClient.put(`/auctions/${modal.id}`, data);
      }
      await reload();
      setModal(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Save failed'));
    }
  };

  const runAction = async (
    id: string,
    action: 'close' | 'cancel' | 'reopen' | 'skip-offer' | 'resend-offer',
  ) => {
    try {
      await moderatorClient.post(`/auctions/${id}/${action}`);
      await reload();
      if (offersFor?.id === id) await openOffers({ ...offersFor });
    } catch (e) {
      alert(apiErrorMessage(e, 'Action failed'));
    }
  };

  const openOffers = async (a: Auction) => {
    setOffersFor(a);
    const { data } = await moderatorClient.get(`/auctions/${a.id}/offers`);
    setOffers(data);
  };

  const openBids = async (a: Auction) => {
    setBidsFor(a);
    const { data } = await moderatorClient.get(`/auctions/${a.id}/bids`);
    setBids(data);
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="font-display text-4xl uppercase">auctions</h1>
        <button onClick={openCreate} className="btrl-button">
          + new auction
        </button>
      </div>

      <div className="space-y-4">
        {filteredAuctions.map((a) => (
          <Card key={a.id}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <h2 className="font-data font-bold text-lg text-off-white">{a.title}</h2>
                <p className="font-data text-xs text-off-white/40">
                  event: {channelName(a.channel_id)} · type: {a.type}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <span className="font-data text-xs text-off-white/55">
                    ends {new Date(a.ends_at).toLocaleString()}
                  </span>
                </div>
                <p className="font-data text-sm text-off-white/55 mt-1">
                  current bid:{' '}
                  {a.current_bid_cents !== null ? fmt(a.current_bid_cents) : 'none yet'}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex gap-2">
                  <button
                    onClick={() => openEdit(a)}
                    className="font-mono text-sm uppercase text-d-yellow hover:text-off-white"
                  >
                    edit
                  </button>
                  {a.status !== 'OPEN' && (
                    <button
                      onClick={() => openOffers(a)}
                      className="font-mono text-sm uppercase text-d-yellow hover:text-off-white"
                    >
                      results
                    </button>
                  )}
                  <button
                    onClick={() => openBids(a)}
                    className="font-mono text-sm uppercase text-d-yellow hover:text-off-white"
                  >
                    bids
                  </button>
                </div>
                <div className="flex gap-2">
                  {a.status === 'OPEN' && (
                    <button
                      onClick={() => runAction(a.id, 'close')}
                      className="font-mono text-xs uppercase text-off-white/70 hover:text-off-white"
                    >
                      force close
                    </button>
                  )}
                  {a.status === 'AWAITING_PAYMENT' && (
                    <>
                      <button
                        onClick={() => runAction(a.id, 'resend-offer')}
                        className="font-mono text-xs uppercase text-off-white/70 hover:text-off-white"
                      >
                        resend
                      </button>
                      <button
                        onClick={() => runAction(a.id, 'skip-offer')}
                        className="font-mono text-xs uppercase text-off-white/70 hover:text-off-white"
                      >
                        skip to next
                      </button>
                    </>
                  )}
                  {a.status === 'CANCELLED' && (
                    <button
                      onClick={() => runAction(a.id, 'reopen')}
                      className="font-mono text-xs uppercase text-off-white/70 hover:text-off-white"
                    >
                      reopen
                    </button>
                  )}
                  {!['SETTLED', 'CANCELLED'].includes(a.status) && (
                    <button
                      onClick={() => runAction(a.id, 'cancel')}
                      className="font-mono text-xs uppercase"
                      style={{ color: 'var(--red)' }}
                    >
                      cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'new auction' : 'edit auction'}
          onClose={() => setModal(null)}
        >
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">title</label>
            <input
              className="w-full px-3 py-2 text-sm"
              value={form.title}
              onChange={(e) => setForm((d) => ({ ...d, title: e.target.value }))}
            />
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              description
            </label>
            <input
              className="w-full px-3 py-2 text-sm"
              value={form.description}
              onChange={(e) => setForm((d) => ({ ...d, description: e.target.value }))}
            />
          </div>
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
                value={form.custom_type_label}
                onChange={(e) => setForm((d) => ({ ...d, custom_type_label: e.target.value }))}
              />
            </div>
          )}
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                starting price ($)
              </label>
              <input
                type="number"
                step="0.01"
                className="w-full px-3 py-2 text-sm"
                value={form.starting_dollars}
                onChange={(e) => setForm((d) => ({ ...d, starting_dollars: e.target.value }))}
              />
            </div>
            <div>
              <label className="block font-data font-bold text-sm mb-1 text-off-white">
                min increment ($)
              </label>
              <input
                type="number"
                step="0.01"
                className="w-full px-3 py-2 text-sm"
                value={form.increment_dollars}
                onChange={(e) => setForm((d) => ({ ...d, increment_dollars: e.target.value }))}
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">ends at</label>
            <input
              type="datetime-local"
              className="w-full px-3 py-2 text-sm"
              value={form.ends_at_local}
              onChange={(e) => setForm((d) => ({ ...d, ends_at_local: e.target.value }))}
            />
          </div>
          <div className="mb-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">image</label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              className="text-sm text-off-white/70"
            />
            {uploading && <p className="font-data text-xs text-off-white/55 mt-1">uploading…</p>}
            {uploadError && (
              <p className="text-sm mt-1" style={{ color: 'var(--red)' }}>
                {uploadError}
              </p>
            )}
            {form.image_url && (
              <img src={form.image_url} alt="preview" className="mt-2 h-24 rounded-sm" />
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
              id="mod_auction_active"
              checked={form.is_active}
              onChange={(e) => setForm((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <label htmlFor="mod_auction_active" className="font-data text-sm text-off-white">
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

      {offersFor && (
        <Modal title={`results — ${offersFor.title}`} onClose={() => setOffersFor(null)}>
          {offers.length === 0 ? (
            <p className="font-body text-sm text-off-white/55">No offers sent yet.</p>
          ) : (
            <div className="space-y-2">
              {offers.map((o) => (
                <Card key={o.id}>
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-data font-bold text-off-white">
                        rank {o.rank} · {fmt(o.amount_cents)}
                      </p>
                      <p className="font-data text-xs text-off-white/55">
                        expires {new Date(o.expires_at).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={o.status} />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Modal>
      )}

      {bidsFor && (
        <Modal title={`bids — ${bidsFor.title}`} onClose={() => setBidsFor(null)}>
          {bids.length === 0 ? (
            <p className="font-body text-sm text-off-white/55">No bids yet.</p>
          ) : (
            <div className="space-y-2">
              {bids.map((b) => (
                <Card key={b.id}>
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-data font-bold text-off-white">{fmt(b.amount_cents)}</p>
                      <p className="font-data text-xs text-off-white/55">
                        {new Date(b.created_at).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={b.status} />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
