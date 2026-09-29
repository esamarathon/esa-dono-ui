import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage } from '../../types';

type BroadcastLevel = 'INFO' | 'WARNING' | 'CRITICAL' | null;

interface Broadcast {
  id: string | null;
  message: string;
  level: BroadcastLevel;
  is_active: boolean;
}

const LEVEL_OPTIONS: { value: BroadcastLevel; label: string }[] = [
  { value: null, label: 'default' },
  { value: 'INFO', label: 'info' },
  { value: 'WARNING', label: 'warning' },
  { value: 'CRITICAL', label: 'critical' },
];

const LEVEL_PREVIEW_STYLE: Record<
  string,
  { background: string; borderLeft: string; color: string }
> = {
  default: {
    background: 'rgba(216, 226, 71, 0.1)',
    borderLeft: '3px solid var(--d-yellow)',
    color: 'var(--off-white)',
  },
  INFO: {
    background: 'rgba(115, 78, 158, 0.15)',
    borderLeft: '3px solid var(--purple)',
    color: 'var(--off-white)',
  },
  WARNING: {
    background: 'rgba(253, 187, 28, 0.15)',
    borderLeft: '3px solid var(--yellow)',
    color: 'var(--off-white)',
  },
  CRITICAL: {
    background: 'rgba(252, 28, 103, 0.15)',
    borderLeft: '3px solid var(--red)',
    color: 'var(--off-white)',
  },
};

export default function AdminBroadcast() {
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<BroadcastLevel>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try {
      const r = await adminClient.get('/broadcast');
      setBroadcast(r.data);
      setMessage(r.data.message || '');
      setLevel(r.data.level ?? null);
    } catch (e) {
      console.error('Failed to load broadcast:', e);
    }
  };

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const saveBroadcast = async () => {
    setError('');
    setSaving(true);
    try {
      const r = await adminClient.put('/broadcast', { message: message.trim(), level });
      setBroadcast(r.data);
      setMessage(r.data.message || '');
      setLevel(r.data.level ?? null);
      // Show success feedback
      setTimeout(() => {
        setError('');
      }, 2000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to save broadcast'));
    } finally {
      setSaving(false);
    }
  };

  const clearBroadcast = async () => {
    setError('');
    setSaving(true);
    try {
      await adminClient.delete('/broadcast');
      setMessage('');
      setLevel(null);
      setBroadcast({ id: null, message: '', level: null, is_active: false });
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to clear broadcast'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="font-display text-4xl uppercase mb-2">broadcast banner</h1>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Display a site-wide announcement banner to all users. Leave empty to disable.
      </p>

      <Card>
        <div className="space-y-4">
          <div>
            <label className="block font-body text-xs uppercase tracking-wider text-off-white/55 mb-2">
              Banner Message
            </label>
            <textarea
              className="w-full px-3 py-2 text-sm font-body"
              rows={4}
              placeholder="Enter announcement message (empty to disable)..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
            />
            <div className="text-xs text-off-white/40 mt-1">{message.length}/500 characters</div>
          </div>

          <div>
            <label
              htmlFor="broadcast-severity"
              className="block font-body text-xs uppercase tracking-wider text-off-white/55 mb-2"
            >
              Severity
            </label>
            <select
              id="broadcast-severity"
              className="w-full px-3 py-2 text-sm font-body"
              value={level ?? ''}
              onChange={(e) => setLevel((e.target.value || null) as BroadcastLevel)}
            >
              {LEVEL_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value ?? ''}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-sm" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}

          {broadcast?.is_active && (
            <div
              className="text-xs p-2 rounded-sm"
              style={{ background: 'rgba(216, 226, 71, 0.1)', color: 'var(--d-yellow)' }}
            >
              ✓ Banner is currently active
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={saveBroadcast} disabled={saving} className="btrl-button flex-1">
              {saving ? 'saving...' : 'save banner'}
            </button>
            {broadcast?.is_active && (
              <button
                onClick={clearBroadcast}
                disabled={saving}
                className="btrl-button"
                style={{ background: 'rgba(239, 238, 236, 0.05)' }}
              >
                {saving ? 'clearing...' : 'clear'}
              </button>
            )}
          </div>
        </div>
      </Card>

      {broadcast?.is_active && (
        <div className="mt-6">
          <h2 className="font-display text-lg uppercase mb-3">Preview</h2>
          <div
            className="px-4 py-3 text-sm rounded-sm whitespace-pre-line"
            style={LEVEL_PREVIEW_STYLE[broadcast.level ?? 'default']}
          >
            {broadcast.message}
          </div>
        </div>
      )}
    </div>
  );
}
