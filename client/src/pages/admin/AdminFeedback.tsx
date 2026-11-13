import { useCallback, useEffect, useState } from 'react';
import {
  getFeedbackItem,
  getFeedbackQueue,
  getFeedbackScreenshot,
  getFeedbackSnapshot,
  markFeedbackSeen,
  updateFeedback,
  type FeedbackQueueDetail,
  type FeedbackQueueFilter,
  type FeedbackQueueItem,
} from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage } from '../../types';
import { isStaleFeedbackBuild, type FeedbackDiagnostics } from '@dono/shared';

const FILTERS: { value: FeedbackQueueFilter; label: string }[] = [
  { value: 'open', label: 'open' },
  { value: 'done', label: 'answered' },
  { value: 'all', label: 'all' },
];

const STATUS_OPTIONS = ['NEW', 'SEEN', 'DONE', 'DECLINED'] as const;

const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  NEW: { background: 'rgba(252,28,103,.18)', color: 'var(--red)' },
  SEEN: { background: 'rgba(211,156,60,.2)', color: 'var(--d-yellow)' },
  DONE: { background: 'rgba(92,189,125,.16)', color: 'var(--green)' },
  DECLINED: { background: 'rgba(239,238,236,.1)', color: 'var(--off-white)' },
};

function statusBadge(status: string) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.NEW;
  return (
    <span className="font-data text-xs font-bold px-2 py-0.5 rounded-sm" style={style}>
      {status.toLowerCase()}
    </span>
  );
}

/** One report on the queue, with its answer form and evidence links. */
function FeedbackCard({ item, onChanged }: { item: FeedbackQueueItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<FeedbackQueueDetail | null>(null);
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.resolution_note);
  const [pr, setPr] = useState(item.resolution_pr);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const expand = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && item.status === 'NEW') {
      // Opening a fresh report marks it seen (the crew-corner rule).
      try {
        await markFeedbackSeen(item.id);
        onChanged();
      } catch {
        /* marking seen is best-effort */
      }
    }
  }, [open, item.id, item.status, onChanged]);

  const loadDetail = useCallback(async () => {
    try {
      const data = await getFeedbackItem(item.id);
      setDetail(data);
      setStatus(data.status);
      setNote(data.resolution_note);
      setPr(data.resolution_pr);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to load report details'));
    }
  }, [item.id]);

  useEffect(() => {
    if (open) void loadDetail();
  }, [open, loadDetail]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await updateFeedback(item.id, {
        status,
        resolution_note: note,
        resolution_pr: pr.trim(),
      });
      setSaved(true);
      onChanged();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to save the answer'));
    } finally {
      setBusy(false);
    }
  };

  const openScreenshot = async () => {
    try {
      const blob = await getFeedbackScreenshot(item.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Screenshot unavailable'));
    }
  };

  const openSnapshot = async () => {
    try {
      const html = await getFeedbackSnapshot(item.id);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Snapshot unavailable'));
    }
  };

  const diagnostics: FeedbackDiagnostics | null = detail?.diagnostics ?? null;
  const answered = item.status === 'DONE' || item.status === 'DECLINED';

  return (
    <Card>
      <div className="flex justify-between items-start gap-4" id={`fb-${item.ref}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="font-data font-bold text-sm">{item.ref}</span>
            {statusBadge(item.status)}
            {item.diagnostics_error_count > 0 && (
              <span
                className="font-data text-xs px-2 py-0.5 rounded-sm"
                style={{ background: 'rgba(252,28,103,.18)', color: 'var(--red)' }}
                title="Client errors captured in the report's diagnostics"
              >
                {item.diagnostics_error_count} client error
                {item.diagnostics_error_count === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p className="font-body text-sm whitespace-pre-wrap mb-2">{item.message}</p>
          <p className="font-data text-xs text-off-white/40">
            {item.sender?.email ?? 'anonymous'} · {new Date(item.created_at).toLocaleString()} ·{' '}
            {item.route || 'unknown page'} · {item.viewport || 'unknown viewport'}
          </p>
          {answered && (
            <div className="mt-3 p-3 rounded-sm" style={{ background: 'rgba(92,189,125,.08)' }}>
              <p className="font-data text-xs uppercase tracking-wider text-off-white/55 mb-1">
                answer {item.resolved_by ? `· ${item.resolved_by}` : ''}
              </p>
              <p className="font-body text-sm whitespace-pre-wrap">
                {item.resolution_note || '(no note)'}
              </p>
              {item.resolution_pr && (
                <a
                  href={item.resolution_pr}
                  target="_blank"
                  rel="noreferrer"
                  className="font-body text-sm text-d-yellow hover:underline"
                >
                  {item.resolution_pr}
                </a>
              )}
            </div>
          )}

          {open && (
            <div className="mt-4 space-y-3">
              <div className="flex gap-2 flex-wrap">
                {item.has_screenshot && (
                  <button onClick={openScreenshot} className="btrl-button text-xs py-1 px-2">
                    screenshot
                  </button>
                )}
                {item.has_snapshot && (
                  <button onClick={openSnapshot} className="btrl-button text-xs py-1 px-2">
                    DOM snapshot
                  </button>
                )}
                {!item.has_screenshot && !item.has_snapshot && (
                  <span className="font-data text-xs text-off-white/40">no evidence files</span>
                )}
              </div>

              {diagnostics && (
                <details className="font-data text-xs text-off-white/55">
                  <summary className="cursor-pointer">
                    diagnostics · {diagnostics.error_count} entr
                    {diagnostics.error_count === 1 ? 'y' : 'ies'}
                    {isStaleFeedbackBuild(diagnostics.context) ? ' · STALE TAB' : ''}
                  </summary>
                  <div
                    className="mt-2 pl-3 border-l-2"
                    style={{ borderColor: 'rgba(239,238,236,.15)' }}
                  >
                    <p>
                      build {diagnostics.context.build_id} (browser{' '}
                      {diagnostics.context.client_build_id}) · role{' '}
                      {diagnostics.context.sender_role ?? 'anonymous'} ·{' '}
                      {new Date(diagnostics.captured_at).toISOString()}
                    </p>
                    {diagnostics.entries.map((e, i) => (
                      <p key={i} className="mt-1 break-all">
                        {e.at} {e.kind}: {e.message}
                      </p>
                    ))}
                  </div>
                </details>
              )}

              <div className="p-3 rounded-sm" style={{ background: 'rgba(239,238,236,.05)' }}>
                <h4 className="font-data font-bold text-sm mb-2 uppercase">handle</h4>
                <div className="flex gap-2 mb-2 items-center flex-wrap">
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="px-2 py-1 text-sm"
                    style={{ background: 'var(--dark-gray)', color: 'var(--off-white)' }}
                    aria-label="Status"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <input
                    type="url"
                    placeholder="PR link"
                    value={pr}
                    onChange={(e) => setPr(e.target.value)}
                    className="flex-1 min-w-[12rem] px-3 py-1 text-sm"
                    aria-label="PR link"
                  />
                </div>
                <textarea
                  rows={2}
                  placeholder="The answer the sender reads — including “no, because”"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full px-3 py-2 text-sm mb-2"
                  aria-label="Resolution note"
                />
                <div className="flex items-center gap-2">
                  <button onClick={save} disabled={busy} className="btrl-button text-xs py-1 px-3">
                    {busy ? 'saving...' : saved ? 'saved' : 'save'}
                  </button>
                  {error && (
                    <span className="text-xs" style={{ color: 'var(--red)' }}>
                      {error}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={expand}
          className="btrl-button text-xs py-1 px-2 shrink-0"
          aria-expanded={open}
        >
          {open ? 'close' : 'open'}
        </button>
      </div>
    </Card>
  );
}

export default function AdminFeedback() {
  const [filter, setFilter] = useState<FeedbackQueueFilter>('open');
  const [items, setItems] = useState<FeedbackQueueItem[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const data = await getFeedbackQueue(filter);
      setItems(data.items);
      setOpenCount(data.open_count);
      setError('');
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to load the feedback queue'));
    }
  }, [filter]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="font-display text-4xl uppercase">feedback</h1>
        {openCount > 0 && (
          <span
            className="font-data text-xs font-bold px-2 py-1 rounded-sm"
            style={{ background: 'rgba(252,28,103,.18)', color: 'var(--red)' }}
          >
            {openCount} open
          </span>
        )}
      </div>
      <p className="font-body text-sm text-off-white/55 mb-6">
        One click, one sentence, taken exactly where the sender was standing, with a picture of the
        page and its live state attached. Every report ends in a visible answer here — including
        “no, because”. The same queue is readable with{' '}
        <code className="font-data">npm run feedback --workspace server</code>.
      </p>

      <div className="flex gap-2 mb-6">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className="btrl-button text-xs py-1 px-3"
            style={
              filter === f.value ? { background: 'var(--d-yellow)', color: 'black' } : undefined
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 text-sm" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <FeedbackCard key={item.id} item={item} onChanged={() => void reload()} />
        ))}
        {items.length === 0 && (
          <p className="font-body text-sm text-off-white/55">No {filter} reports.</p>
        )}
      </div>
    </div>
  );
}
