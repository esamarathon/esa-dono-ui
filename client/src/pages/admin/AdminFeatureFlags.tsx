import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage } from '../../types';

export interface FeatureFlag {
  id: string;
  name: string;
  description: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export default function AdminFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [newFlag, setNewFlag] = useState({ name: '', description: '' });
  const [error, setError] = useState('');

  const reload = () => adminClient.get('/feature-flags').then((r) => setFlags(r.data));

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const addFlag = async () => {
    if (!newFlag.name.trim()) return;
    setError('');
    try {
      await adminClient.post('/feature-flags', {
        name: newFlag.name.trim(),
        description: newFlag.description.trim() || null,
      });
      setNewFlag({ name: '', description: '' });
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to create feature flag'));
    }
  };

  const toggleFlag = async (name: string, currentState: boolean) => {
    try {
      await adminClient.patch(`/feature-flags/${name}`, { is_enabled: !currentState });
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to update feature flag'));
    }
  };

  const deleteFlag = async (name: string) => {
    if (!confirm(`Delete feature flag "${name}"?`)) return;
    try {
      await adminClient.delete(`/feature-flags/${name}`);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to delete feature flag'));
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="font-display text-4xl uppercase mb-6">feature flags</h1>
      <p className="font-body text-sm text-off-white/55 mb-6">
        Feature flags control which features are enabled. All flags are disabled by default and must
        be explicitly toggled on.
      </p>

      <Card className="mb-6">
        <h2 className="font-data font-bold text-lg mb-4">Create New Flag</h2>
        <div className="space-y-3">
          <input
            type="text"
            className="w-full px-3 py-2 text-sm"
            placeholder="Flag name (e.g., auctions)"
            value={newFlag.name}
            onChange={(e) => setNewFlag({ ...newFlag, name: e.target.value })}
          />
          <textarea
            className="w-full px-3 py-2 text-sm"
            placeholder="Description (optional)"
            value={newFlag.description}
            onChange={(e) => setNewFlag({ ...newFlag, description: e.target.value })}
            rows={2}
          />
          <button onClick={addFlag} className="btrl-button w-full">
            create flag
          </button>
        </div>
      </Card>

      {error && (
        <p className="mb-4 text-sm" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div className="space-y-3">
        {flags.map((flag) => (
          <Card key={flag.id}>
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1">
                <h3 className="font-data font-bold text-base mb-1">{flag.name}</h3>
                {flag.description && (
                  <p className="font-body text-sm text-off-white/55 mb-2">{flag.description}</p>
                )}
                <p className="font-data text-xs text-off-white/40">
                  Status:{' '}
                  <span style={{ color: flag.is_enabled ? 'var(--green)' : 'var(--red)' }}>
                    {flag.is_enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => toggleFlag(flag.name, flag.is_enabled)}
                  className="btrl-button text-xs py-1 px-2"
                  style={{
                    background: flag.is_enabled ? 'rgba(92,189,125,.16)' : 'rgba(239,68,68,.16)',
                    color: flag.is_enabled ? 'var(--green)' : 'var(--red)',
                  }}
                >
                  {flag.is_enabled ? 'disable' : 'enable'}
                </button>
                <button
                  onClick={() => deleteFlag(flag.name)}
                  className="btrl-button text-xs py-1 px-2"
                  style={{ background: 'rgba(239,68,68,.16)', color: 'var(--red)' }}
                >
                  delete
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
