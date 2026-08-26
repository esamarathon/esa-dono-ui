import { useEffect, useState } from 'react';
import { getAuctions, placeBid } from '../api/auctions';
import Card from '../components/Card';
import LoadingSpinner from '../components/LoadingSpinner';
import { apiErrorMessage, type Auction } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function timeLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'ended';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function AuctionCard({ auction, onBid }: { auction: Auction; onBid: () => void }) {
  const [amount, setAmount] = useState(
    auction.min_next_bid_cents ? (auction.min_next_bid_cents / 100).toFixed(2) : '',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isOpen = auction.status === 'OPEN';

  const submit = async () => {
    setError('');
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a valid bid amount.');
      return;
    }
    setBusy(true);
    try {
      await placeBid(auction.id, cents);
      onBid();
    } catch (e) {
      setError(
        apiErrorMessage(
          e,
          'Could not place bid. You may need a verified email and a prior donation to bid.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {auction.image_url && (
        <img
          src={auction.image_url}
          alt={auction.title}
          className="w-full h-48 object-cover mb-3 rounded-sm"
        />
      )}
      <h2 className="font-data font-bold text-lg text-off-white">{auction.title}</h2>
      {auction.description && (
        <p className="font-body text-sm text-off-white/55 mb-2">{auction.description}</p>
      )}
      <div className="flex justify-between items-center mb-3">
        <div>
          <p className="font-data text-sm text-off-white/55">current bid</p>
          <p className="font-display text-2xl text-d-yellow">
            {auction.current_bid_cents !== null
              ? fmt(auction.current_bid_cents)
              : fmt(auction.starting_price_cents)}
          </p>
        </div>
        <p className="font-data text-sm text-off-white/55">
          {isOpen ? timeLeft(auction.ends_at) : auction.status.replace('_', ' ').toLowerCase()}
        </p>
      </div>
      {isOpen && (
        <div className="flex gap-2 items-start">
          <input
            type="number"
            step="0.01"
            min={(auction.min_next_bid_cents ?? auction.starting_price_cents) / 100}
            className="flex-1 px-3 py-2 text-sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button onClick={submit} disabled={busy} className="btrl-button">
            {busy ? 'bidding…' : 'bid'}
          </button>
        </div>
      )}
      {auction.min_next_bid_cents !== null && isOpen && (
        <p className="font-data text-xs text-off-white/40 mt-1">
          minimum next bid: {fmt(auction.min_next_bid_cents)}
        </p>
      )}
      {error && (
        <p className="text-sm mt-2" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}
    </Card>
  );
}

export default function Auctions() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = () => getAuctions().then(setAuctions);

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="font-display text-4xl uppercase mb-2">auctions</h1>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Bidding requires a verified email and at least one prior donation. Bids are commitments, not
        wallet charges — the winner is invoiced via a payment link after the auction closes.
      </p>
      {auctions.length === 0 ? (
        <p className="font-body text-sm text-off-white/55">No auctions right now.</p>
      ) : (
        <div className="space-y-4">
          {auctions.map((a) => (
            <AuctionCard key={a.id} auction={a} onBid={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
