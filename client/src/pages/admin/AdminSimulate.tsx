import { useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import { apiErrorMessage } from '../../types';
import { sanitizeMoneyInput } from '../../utils/money';
import { MIN_SPEND_CENTS, MIN_SPEND_DOLLARS } from '../../config';

interface SimulateResult {
  token: string;
  donor: { balance_remaining: number };
}

export default function AdminSimulate() {
  const [form, setForm] = useState({ email: '', donor_name: '', amount: '10.00', comment: '' });
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSimulate = async () => {
    setError('');
    setResult(null);
    const cents = Math.round(parseFloat(form.amount) * 100);
    if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
      setError(`Minimum amount is $${MIN_SPEND_DOLLARS.toFixed(2)}`);
      return;
    }
    setLoading(true);
    try {
      const { data } = await adminClient.post('/simulate-donation', {
        email: form.email,
        donor_name: form.donor_name || undefined,
        amount_cents: cents,
        comment: form.comment || undefined,
      });
      setResult(data);
    } catch (e) {
      setError(apiErrorMessage(e, 'Simulation failed'));
    } finally {
      setLoading(false);
    }
  };

  const magicLink = result ? `${window.location.origin}/wallet?token=${result.token}` : '';

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="font-display text-4xl lowercase mb-6">simulate donation</h1>
      <Card className="mb-4">
        <p className="font-body text-sm text-off-white/55 mb-4">
          Creates a simulated donation without processing real money through Tiltify. The donor
          receives a magic link and balance exactly as if they donated via Tiltify.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block font-data font-bold text-sm mb-1 text-off-white">email *</label>
            <input
              type="email"
              className="w-full px-3 py-2 text-sm"
              placeholder="donor@example.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              donor name
            </label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="Anonymous"
              value={form.donor_name}
              onChange={(e) => setForm((f) => ({ ...f, donor_name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              amount ($) *
            </label>
            <input
              type="number"
              step="0.01"
              min={MIN_SPEND_DOLLARS}
              className="w-full px-3 py-2 text-sm"
              value={form.amount}
              onChange={(e) =>
                setForm((f) => ({ ...f, amount: sanitizeMoneyInput(e.target.value) }))
              }
            />
          </div>
          <div>
            <label className="block font-data font-bold text-sm mb-1 text-off-white">comment</label>
            <input
              className="w-full px-3 py-2 text-sm"
              placeholder="Optional comment"
              value={form.comment}
              onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
            />
          </div>
        </div>

        {error && (
          <p className="text-sm mt-3" style={{ color: 'var(--red)' }}>
            {error}
          </p>
        )}

        <button onClick={handleSimulate} disabled={loading} className="btrl-button mt-4">
          {loading ? 'simulating...' : 'simulate donation'}
        </button>
      </Card>

      {result && (
        <Card style={{ borderColor: 'rgba(92,189,125,.3)' }}>
          <h2 className="font-data font-bold text-lg mb-2" style={{ color: 'var(--green)' }}>
            donation created!
          </h2>
          <p className="font-data text-sm" style={{ color: 'var(--green)' }}>
            balance: ${(result.donor.balance_remaining / 100).toFixed(2)}
          </p>
          <div className="mt-3">
            <label className="block font-data font-bold text-sm mb-1 text-off-white">
              magic link:
            </label>
            <div className="flex gap-2">
              <input readOnly className="flex-1 px-2 py-1 text-xs" value={magicLink} />
              <button
                onClick={() => navigator.clipboard.writeText(magicLink)}
                className="btrl-button btrl-button-ghost text-xs"
              >
                copy
              </button>
            </div>
            <a
              href={magicLink}
              target="_blank"
              rel="noreferrer"
              className="font-data text-sm underline mt-1 inline-block text-d-yellow hover:text-off-white"
            >
              open wallet &rarr;
            </a>
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <h3 className="font-data font-bold text-sm mb-2 text-off-white">curl alternative</h3>
        <p className="font-body text-xs text-off-white/55 mb-2">
          When TILTIFY_WEBHOOK_SECRET is unset, you can POST directly to the webhook:
        </p>
        <pre
          className="p-3 rounded-sm text-xs overflow-x-auto"
          style={{ background: 'rgba(0,0,0,0.4)', color: 'var(--green)' }}
        >{`curl -X POST http://localhost:3001/api/webhooks/tiltify \\
  -H "Content-Type: application/json" \\
  -d '{"meta":{"event_type":"donation.completed"},"data":{"id":"test-123","donor_email":"test@example.com","donor_name":"Test","amount":{"value":"10.00"},"comment":"test"}}'`}</pre>
      </Card>
    </div>
  );
}
