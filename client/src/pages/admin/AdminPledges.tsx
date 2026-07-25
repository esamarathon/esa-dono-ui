import { useEffect, useState, Fragment } from 'react';
import adminClient from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
import type { AdminPledge } from '../../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function ago(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export default function AdminPledges() {
  const [pledges, setPledges] = useState<AdminPledge[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    adminClient
      .get('/pledges')
      .then((r) => setPledges(r.data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <h1 className="font-display text-4xl lowercase mb-4">pledges</h1>
      <p className="font-body text-sm text-off-white/55 mb-4">
        {pledges.length} total pledges. Each pledge is created when a donor builds a cart, then
        fulfilled when a matching donation arrives.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'rgba(239,238,236,.03)' }}>
              {['status', 'email', 'total', 'items', 'relay', 'fulfilled by', 'created', ''].map(
                (h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {pledges.map((p) => (
              <Fragment key={p.id}>
                <tr
                  style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
                  className="cursor-pointer hover:opacity-80"
                  onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                >
                  <td className="px-4 py-2">
                    <span
                      className="font-mono text-[10px] px-2 py-0.5 rounded-sm font-bold"
                      style={{
                        background:
                          p.status === 'FULFILLED'
                            ? 'rgba(92,189,125,.16)'
                            : p.status === 'OPEN'
                              ? 'rgba(115,78,158,.3)'
                              : 'rgba(208,152,70,.16)',
                        color:
                          p.status === 'FULFILLED'
                            ? 'var(--green)'
                            : p.status === 'OPEN'
                              ? 'var(--off-white)'
                              : 'var(--d-yellow)',
                      }}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">{p.donor_email || '-'}</td>
                  <td className="px-4 py-2 font-data font-bold text-off-white">
                    {fmt(p.total_cents)}
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">{p.items.length}</td>
                  <td className="px-4 py-2 font-mono text-[10px] text-off-white/55 max-w-[120px] truncate">
                    {p.relay_client_key ? `${p.relay_client_key.slice(0, 16)}...` : '-'}
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">
                    {p.fulfilled_by
                      ? `${p.fulfilled_by.donor?.email || '-'} (${fmt(p.fulfilled_by.amount_cents)})`
                      : '-'}
                  </td>
                  <td className="px-4 py-2 font-data text-off-white/55">{ago(p.created_at)}</td>
                  <td className="px-4 py-2 text-off-white/55">
                    {expanded === p.id ? '\u25b2' : '\u25bc'}
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-items`}>
                    <td colSpan={8} className="px-8 py-4" style={{ background: 'rgba(0,0,0,.2)' }}>
                      <div className="space-y-2">
                        <div className="grid grid-cols-5 gap-2 font-mono text-[10px] uppercase tracking-wider text-off-white/55 mb-1">
                          <span>kind</span>
                          <span>target</span>
                          <span>amount</span>
                          <span>poll</span>
                          <span>data</span>
                        </div>
                        {p.items.map((item) => (
                          <div
                            key={item.id}
                            className="grid grid-cols-5 gap-2 font-data text-sm text-off-white"
                          >
                            <span>{item.kind}</span>
                            <span className="font-mono text-[10px] truncate">{item.target_id}</span>
                            <span className="text-d-yellow">{fmt(item.amount_cents)}</span>
                            <span className="font-mono text-[10px] text-off-white/55 truncate">
                              {item.poll_id || '-'}
                            </span>
                            <span className="font-mono text-[10px] text-off-white/55 truncate">
                              {item.data || '-'}
                            </span>
                          </div>
                        ))}
                        {p.relay_key_id && (
                          <div
                            className="mt-3 pt-3"
                            style={{ borderTop: '1px solid rgba(239,238,236,.08)' }}
                          >
                            <p className="font-mono text-[10px] text-off-white/55">
                              relay_key_id: {p.relay_key_id}
                            </p>
                            <p className="font-mono text-[10px] text-off-white/55">
                              relay_client_key: {p.relay_client_key}
                            </p>
                            <p className="font-mono text-[10px] text-off-white/55">
                              expires: {new Date(p.expires_at).toLocaleString()}
                            </p>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
