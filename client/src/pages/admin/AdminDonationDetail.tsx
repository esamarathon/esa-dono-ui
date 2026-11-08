import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import adminClient from '../../api/admin';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import ChannelPill from '../../components/ChannelPill';
import InfoTip from '../../components/InfoTip';
import { Amount, NotMoneyNote } from '../../components/StaffAmounts';
import { fmt } from '../../utils/money';
import PaymentRefunds, { ClaimPaymentRefund } from './PaymentRefunds';
import {
  apiErrorMessage,
  type AdminDonationDetail as Detail,
  type DonationReversalPreview,
  type PoolCategory,
} from '../../types';
const CATEGORIES: PoolCategory[] = ['reward', 'poll', 'goal'];
const TABS = ['pools', 'payment refunds', 'flags & ended targets', 'details'];
export default function AdminDonationDetail() {
  const { id } = useParams();
  const activeId = useRef(id);
  activeId.current = id;
  const [donation, setDonation] = useState<Detail | null>(null);
  const [tab, setTab] = useState('pools');
  const [open, setOpen] = useState<PoolCategory | null>(null);
  const [preview, setPreview] = useState<DonationReversalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    const read = await adminClient.get<Detail>(`/donations/${id}`);
    if (activeId.current !== id) return;
    setDonation(read.data);
    setRevision((r) => r + 1);
  }, [id]);
  useEffect(() => {
    setPreview(null);
    setDonation(null);
    reload().catch((e) => setError(apiErrorMessage(e, 'Cannot load donation')));
  }, [reload]);
  const action = async (status: 'REFUNDED' | 'CHARGEBACK') => {
    setBusy(true);
    setError('');
    try {
      const { data } = await adminClient.get<DonationReversalPreview>(
        `/donations/${id}/reversal-preview`,
        { params: { status } },
      );
      if (activeId.current === data.donation_id) setPreview(data);
    } catch (e) {
      setError(apiErrorMessage(e, 'Cannot preview action'));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await adminClient.patch(`/donations/${preview.donation_id}/status`, {
        status: preview.status,
      });
      setPreview(null);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Action failed. Reload and review again.'));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const acknowledge = async (claimId: string) => {
    setError('');
    try {
      await adminClient.post(`/claims/${claimId}/acknowledge-chargeback`, {});
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Cannot acknowledge claim'));
    }
  };
  if (!donation) return error ? <p role="alert">{error}</p> : <LoadingSpinner />;
  const d = donation;
  return (
    <div className="max-w-6xl space-y-4">
      <Link to="/admin/donations" className="font-mono text-sm text-off-white/55">
        ← donations
      </Link>
      <header className="btrl-panel-dark p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl uppercase">{d.donor_name ?? 'Anonymous'}</h1>
            <span className="font-mono">{d.status}</span>
            <p>
              {d.event?.name} {d.event?.ended_at && '(ended)'}
            </p>
            <ChannelPill label={d.channel?.name ?? 'unassigned'} />
          </div>
          <div className="space-y-2">
            {(['REFUNDED', 'CHARGEBACK'] as const).map((status) => (
              <div key={status}>
                <button
                  className={`btrl-button ${status === 'CHARGEBACK' ? 'btrl-button-outline' : ''}`}
                  disabled={busy || !!d.action_disabled_reasons[status]}
                  onClick={() => action(status)}
                >
                  {status === 'REFUNDED' ? 'Wallet refund' : 'Record chargeback'}
                </button>
                {d.action_disabled_reasons[status] && (
                  <p className="font-body text-sm text-off-white/55">
                    {d.action_disabled_reasons[status]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-off-white/10 pt-4">
          <Amount cents={d.amount_cents} label="Money" money />
          <span>
            Pledge amount: {d.pledge_amount_cents == null ? '—' : fmt(d.pledge_amount_cents)}
          </span>
          <Amount cents={d.wallet_applied_cents} label="Wallet credit applied" />
        </div>
      </header>
      <NotMoneyNote />
      {error && <p role="alert">{error}</p>}
      {d.needs_attention && (
        <div role="alert" className="btrl-panel p-3">
          <h2>Needs attention</h2>
          {d.flags.map((flag) => (
            <span key={flag} className="mr-2">
              {flag}
            </span>
          ))}
        </div>
      )}
      <div role="tablist" className="flex flex-wrap gap-3 border-b border-off-white/10">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className="font-data uppercase py-3"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'pools' && (
        <>
          {d.pledge_amount_cents == null && (
            <p>
              No pledge amount: this legacy donation has no Pools. Recorded live allocations remain
              below.
            </p>
          )}
          <div className="flex flex-wrap gap-4 font-body text-sm text-off-white/55">
            <span>
              Pool credit{' '}
              <InfoTip text="The donor can choose again in this category in the same Event, except physical rewards. This is not Wallet credit." />
            </span>
            <span>
              Unused pool money{' '}
              <InfoTip text="Poll or goal Pool budget that is neither allocated nor Pool credit. Staff can assign it; donors cannot spend it. Rewards have no Unused pool money." />
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    'Pool',
                    'Pool size',
                    'allocated (live)',
                    'Pool credit',
                    'Unused pool money',
                    '',
                  ].map((h) => (
                    <th key={h} className="p-3 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map((category) => (
                  <Fragment key={category}>
                    <tr className="border-t border-off-white/10">
                      <th className="p-3">{category}</th>
                      <td>{d.pledge_amount_cents == null ? '—' : fmt(d.pledge_amount_cents)}</td>
                      <td>{fmt(d.pools[category].live_cents)}</td>
                      <td title="The donor can choose again in this category in the same Event, except physical rewards. Not Wallet credit.">
                        {fmt(d.pools[category].pool_credit_cents)}
                      </td>
                      <td title="Not allocated or Pool credit. Staff can assign poll and goal Unused pool money; donors cannot spend it.">
                        {category === 'reward' ? 'n/a' : fmt(d.pools[category].unused_cents)}
                      </td>
                      <td>
                        <button
                          className="underline"
                          aria-expanded={open === category}
                          aria-label={`${open === category ? 'Hide' : 'Show'} ${category} allocation rows`}
                          onClick={() => setOpen(open === category ? null : category)}
                        >
                          {open === category ? 'Hide rows −' : 'Show rows +'}
                        </button>
                      </td>
                    </tr>
                    {open === category &&
                      d.allocations[category].map((row) => (
                        <tr key={row.id} className="border-t border-off-white/10 bg-purple/10">
                          <td colSpan={6} className="p-3 space-y-2">
                            <div className="flex flex-wrap gap-3">
                              <span>{row.label}</span>
                              <ChannelPill label={row.channel} />
                              <span className="font-mono">{row.source}</span>
                              <span>{row.status}</span>
                              <Amount cents={row.amount_cents} label="allocated" />
                            </div>
                            {row.allocated_by && (
                              <p>
                                {row.allocated_by} · {row.allocated_at}
                              </p>
                            )}
                            {category === 'reward' && (
                              <>
                                <p>
                                  Recorded entitlement: {fmt(row.recorded_amount_cents!)} (price now{' '}
                                  {fmt(row.current_price_cents!)})
                                </p>
                                <ClaimPaymentRefund
                                  key={`${revision}-${row.id}`}
                                  claimId={row.id}
                                  onChanged={reload}
                                />
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="font-body text-sm text-off-white/55">
            Pool credit lets the donor choose again in one category in the same Event (not physical
            rewards). Unused pool money is for staff assignment, not donor spending. At Event end
            poll/goal credit becomes Unused pool money; reward credit expires.
          </p>
        </>
      )}
      {tab === 'payment refunds' && <PaymentRefunds key={revision} donationId={d.id} />}
      {tab === 'flags & ended targets' && (
        <div className="space-y-4">
          <h2 className="font-display text-xl">Flagged shipped claims</h2>
          {d.allocations.reward
            .filter((r) => r.chargeback_flagged_at)
            .map((r) => (
              <div key={r.id}>
                {r.label} · recorded {fmt(r.recorded_amount_cents!)}{' '}
                <button className="btrl-button" onClick={() => acknowledge(r.id)}>
                  acknowledge shipped claim
                </button>
              </div>
            ))}
          <h2 className="font-display text-xl">Ended targets whose totals changed</h2>
          {d.ended_target_changes?.map((target) => (
            <p key={`${target.payment_refund_id}-${target.target_id}`}>
              {target.label}: {fmt(target.before_cents)} → {fmt(target.after_cents)}{' '}
              {target.ended && '· ended'} {target.completed && '· stays complete'} · Payment refund{' '}
              {target.payment_refund_id}
            </p>
          ))}
        </div>
      )}
      {tab === 'details' && (
        <dl className="font-body text-sm space-y-2">
          <dt>Donor email (admin only)</dt>
          <dd>{d.donor?.email}</dd>
          <dt>Donation</dt>
          <dd>{d.id}</dd>
          <dt>Payment source</dt>
          <dd>{d.external_id}</dd>
          <dt>Received</dt>
          <dd>{d.created_at}</dd>
          <dt>Comment</dt>
          <dd>{d.comment ?? '—'}</dd>
        </dl>
      )}
      {preview && (
        <Modal
          title={preview.status === 'REFUNDED' ? 'Wallet refund' : 'Record chargeback'}
          onClose={() => !busy && setPreview(null)}
        >
          <div className="space-y-3 font-body text-sm">
            <p>
              Server-computed preview · {preview.accounting}. Nothing changed yet. Whole-donation
              action, not a Payment refund.
            </p>
            <Amount cents={preview.wallet_adjustment_cents} label="Wallet credit change" />
            <p>
              Counted money: {fmt(preview.money_before_cents)} → {fmt(preview.money_after_cents)}
            </p>
            {CATEGORIES.map((c) => (
              <section key={c}>
                <p>
                  {c}: {preview.reversed_rows[c]} rows reversed; Pool credit cleared{' '}
                  {fmt(preview.cleared_pool_credit_cents[c])}; Unused cleared{' '}
                  {c === 'reward' ? 'n/a' : fmt(preview.cleared_unused_cents[c])}
                </p>
                {preview.reversed_allocation_ids[c].map((id) => {
                  const row = d.allocations[c].find((r) => r.id === id);
                  return (
                    <p key={id}>
                      {row?.label ?? id} · {row?.source ?? 'see recorded allocation'} · reverses
                      allocation {id}
                    </p>
                  );
                })}
              </section>
            ))}
            <p>
              Fulfilled claims retained: {preview.retained_claim_ids.join(', ') || 'none'}.{' '}
              {preview.status === 'CHARGEBACK' && 'Retained claims are flagged for admin review.'}
            </p>
            <p>
              Overlapping categories are not added together. The server uses recorded funding,
              retained claims and prior Wallet grants.
            </p>
            <NotMoneyNote />
            <button className="btrl-button" disabled={busy} onClick={confirm}>
              confirm {preview.status === 'REFUNDED' ? 'Wallet refund' : 'Record chargeback'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
