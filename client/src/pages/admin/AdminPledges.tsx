import { useCallback, useEffect, useRef, useState, Fragment } from 'react';
import adminClient from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
import { NotMoneyNote } from '../../components/StaffAmounts';
import { fmt } from '../../utils/money';
import { apiErrorMessage, type AdminPledge } from '../../types';
const STATUSES = ['OPEN', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'LEGACY_PAID', 'PAYMENT_REVIEW'];
export default function AdminPledges() {
  const [pledges, setPledges] = useState<AdminPledge[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('OPEN');
  const [overdue, setOverdue] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const reload = useCallback(async () => {
    const revision = ++requestRevision.current;
    const result = await adminClient.get<AdminPledge[]>('/pledges', {
      params: {
        ...(status === 'LEGACY_PAID' ? { payment_state: 'LEGACY_PAID' } : status ? { status } : {}),
        ...(overdue ? { overdue: 'true' } : {}),
        offset,
        limit: 50,
      },
    });
    if (revision !== requestRevision.current) return;
    setPledges(result.data);
    setTotal(Number(result.headers?.['x-total-count'] ?? result.data.length));
  }, [status, overdue, offset]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    reload()
      .catch((e) => {
        if (live) setError(apiErrorMessage(e, 'Failed to load pledges'));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reload]);
  const check = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await adminClient.post(`/pledges/${id}/check-stripe`);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Stripe state is unresolved; funding stays held.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      <h1 className="font-display text-4xl uppercase">pledges</h1>
      <p className="font-body text-sm text-off-white/55">
        {total} total pledges matching filters. Draft pledges stay in the browser. This list
        contains server-confirmed Pending pledges. A deadline does not prove non-payment. Check
        Stripe; never manually release a hold.
      </p>
      <NotMoneyNote />
      <div className="flex flex-wrap gap-2">
        {['', ...STATUSES].map((s) => (
          <button
            key={s}
            className="btrl-button btrl-button-outline"
            aria-pressed={s === status}
            onClick={() => {
              setStatus(s);
              setOffset(0);
            }}
          >
            {s || 'all'}
          </button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => {
              setOverdue(e.target.checked);
              setOffset(0);
            }}
          />{' '}
          overdue only
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <LoadingSpinner />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {[
                  'status',
                  'email',
                  'pledge amount',
                  'held Wallet credit',
                  'new money due / shipping',
                  'Stripe Session / payment',
                  'deadline',
                  'donation',
                  '',
                ].map((h) => (
                  <th key={h} className="text-left p-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pledges.map((p) => (
                <Fragment key={p.id}>
                  <tr className="border-t border-off-white/10">
                    <td className="p-3">
                      <span>{p.status}</span>
                      {p.overdue && <strong> · overdue</strong>}
                      {p.payment_state === 'LEGACY_PAID' && (
                        <p>paid after transition: not fulfilled</p>
                      )}
                      {p.payment_state === 'PAYMENT_REVIEW' && (
                        <p>Needs admin review: cash-only recovery, not original fulfillment</p>
                      )}
                    </td>
                    <td>{p.donor_email ?? '—'}</td>
                    <td>{p.pledge_amount_cents == null ? '—' : fmt(p.pledge_amount_cents)}</td>
                    <td>
                      {fmt(p.wallet_held_cents)} currently held
                      <p>
                        Confirmed Wallet funding: {fmt(p.held_wallet_cents)} ·{' '}
                        {p.wallet_hold_status}
                      </p>
                    </td>
                    <td>
                      <span>{p.new_money_cents == null ? '—' : fmt(p.new_money_cents)}</span>
                      <p className="text-off-white/55">
                        Shipping (outside totals):{' '}
                        {p.shipping_cents == null
                          ? 'unknown / calculated by Stripe'
                          : fmt(p.shipping_cents)}
                      </p>
                    </td>
                    <td>
                      {p.checkout_session_status ?? 'not bound'} / {p.payment_status ?? 'unknown'}
                      <p>{p.payment_state}</p>
                    </td>
                    <td>{new Date(p.expires_at).toLocaleString()}</td>
                    <td>
                      {p.fulfilled_by ? (
                        <a href={`/admin/donations/${p.fulfilled_by.id}`} className="underline">
                          Donation {p.fulfilled_by.id}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        className="btrl-button"
                        disabled={
                          busy === p.id ||
                          ['LEGACY_PAID', 'PAYMENT_REVIEW'].includes(p.payment_state)
                        }
                        onClick={() => check(p.id)}
                      >
                        Check Stripe
                      </button>
                      <button
                        className="underline ml-2"
                        onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                      >
                        items / prices
                      </button>
                    </td>
                  </tr>
                  {expanded === p.id && (
                    <tr>
                      <td colSpan={9} className="p-4 bg-purple/10">
                        {p.items.map((item) => (
                          <p key={item.id}>
                            {item.label} · {item.kind} · recorded allocation{' '}
                            {fmt(item.amount_cents)}{' '}
                            {item.kind === 'REWARD' &&
                              `· confirmed unit price ${item.unit_price_cents == null ? 'unavailable' : fmt(item.unit_price_cents)} · price now ${item.current_price_cents == null ? 'unavailable' : fmt(item.current_price_cents)}`}
                          </p>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-3">
        <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
          previous
        </button>
        <span>
          {offset + pledges.length} of {total}
        </span>
        <button disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>
          next
        </button>
      </div>
    </div>
  );
}
