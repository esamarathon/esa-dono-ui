import { useCallback, useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Modal from '../../components/Modal';
import { Amount } from '../../components/StaffAmounts';
import { fmt } from '../../utils/money';
import {
  apiErrorMessage,
  type PaymentRefundList,
  type PaymentRefundRecord,
  type PaymentRefundShrink,
  type PaymentRefundPreview,
  type DonationStatus,
} from '../../types';

export function PoolShrink({ plan }: { plan: PaymentRefundShrink }) {
  return (
    <div className="space-y-2 font-body text-sm">
      <p>
        Money: {fmt(plan.money_before_cents)} → {fmt(plan.money_after_cents)}
      </p>
      <p>
        Pledge amount: {fmt(plan.pledge_before_cents)} → {fmt(plan.pledge_after_cents)}
      </p>
      <p>Wallet credit applied (unchanged): {fmt(plan.wallet_applied_cents)}</p>
      {(['reward', 'poll', 'goal'] as const).map((category) => (
        <p key={category}>
          {category} Pool: {fmt(plan.categories[category].before_cents)} →{' '}
          {fmt(plan.categories[category].after_cents)}; slack consumed{' '}
          {fmt(plan.categories[category].unused_consumed_cents)}; allocations/credit reduced{' '}
          {fmt(plan.categories[category].reduced_cents)}
        </p>
      ))}
      <h3>Targets lowered (including ended polls and completed goals)</h3>
      {plan.affected_targets.map((target) => (
        <p key={target.target_id}>
          {target.label}: {fmt(target.before_cents)} → {fmt(target.after_cents)}{' '}
          {target.ended && '· ended'} {target.completed && '· stays complete'}
        </p>
      ))}
      <details>
        <summary>Financial components</summary>
        {plan.components.map((row) => (
          <p key={`${row.kind}-${row.id}`}>
            {row.category} · {row.kind} {row.id}: {fmt(row.before_cents)} → {fmt(row.after_cents)}
          </p>
        ))}
      </details>
    </div>
  );
}
export function ClaimPaymentRefund({
  claimId,
  onChanged,
}: {
  claimId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<PaymentRefundPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    adminClient
      .get(`/claims/${claimId}/payment-refund-preview`)
      .then((r) => {
        if (live) setPreview(r.data);
      })
      .catch((e) => {
        if (live) setError(apiErrorMessage(e, 'Cannot load Payment refund eligibility'));
      });
    return () => {
      live = false;
    };
  }, [claimId]);
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await adminClient.post(`/claims/${claimId}/payment-refund`);
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(
        apiErrorMessage(
          e,
          'Request or refresh failed. Check Payment refunds before starting another cancellation.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <button
        className="btrl-button btrl-button-outline"
        disabled={!preview?.eligible || busy}
        onClick={() => setOpen(true)}
      >
        Cancel with Payment refund
      </button>
      {preview && !preview.eligible && (
        <p className="text-sm text-off-white/55">{preview.reason}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {open && preview?.eligible && (
        <Modal title="Cancel with Payment refund" onClose={() => !busy && setOpen(false)}>
          <p>
            Server preview. Only this physical claim is cancelled. Other reward entitlements stay
            intact.
          </p>
          <p>
            Item return: {fmt(preview.item_cents)} · Shipping return (outside totals):{' '}
            {fmt(preview.shipping_cents)}
          </p>
          <PoolShrink plan={preview.pool_shrink} />
          <p>
            Stripe acceptance applies these changes before final settlement. A later failure needs
            explicit item and shipping recovery.
          </p>
          <button className="btrl-button" disabled={busy} onClick={confirm}>
            confirm Payment refund
          </button>
        </Modal>
      )}
    </div>
  );
}
const ALL = 'REQUESTED,PENDING,REQUIRES_ACTION,SUCCEEDED,FAILED,RESOLVED';
export default function PaymentRefunds({ donationId }: { donationId?: string }) {
  const [list, setList] = useState<PaymentRefundList>({
    records: [],
    total: 0,
    offset: 0,
    limit: 50,
  });
  const [all, setAll] = useState(!!donationId);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{
    record: PaymentRefundRecord;
    kind: 'retry' | 'item' | 'shipping';
  } | null>(null);
  const [resolution, setResolution] = useState('RETURNED_OUTSIDE_APP');
  const [donationStatus, setDonationStatus] = useState<DonationStatus | null>(null);
  const reload = useCallback(async () => {
    const { data } = await adminClient.get<PaymentRefundList>('/payment-refunds', {
      params: {
        offset,
        limit: 50,
        ...(donationId ? { donation_id: donationId } : {}),
        ...(all ? { status: ALL } : {}),
      },
    });
    setList(data);
  }, [donationId, all, offset]);
  useEffect(() => {
    reload().catch((e) => setError(apiErrorMessage(e, 'Failed to load Payment refunds')));
  }, [reload]);
  const start = async (record: PaymentRefundRecord, kind: 'retry' | 'item' | 'shipping') => {
    setAction({ record, kind });
    setResolution('RETURNED_OUTSIDE_APP');
    setDonationStatus(null);
    setError('');
    if (kind === 'item') {
      try {
        const { data } = await adminClient.get(`/donations/${record.donation_id}`);
        setDonationStatus(data.status);
      } catch (e) {
        setError(apiErrorMessage(e, 'Cannot load source donation status'));
      }
    }
  };
  const confirm = async () => {
    if (!action) return;
    setBusy(true);
    setError('');
    try {
      const path = `/payment-refunds/${action.record.id}/${action.kind === 'retry' ? 'retry' : `resolve-${action.kind}`}`;
      if (action.kind === 'retry') await adminClient.post(path);
      else await adminClient.post(path, { resolution });
      setAction(null);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, 'Payment refund action failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      <label>
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => {
            setAll(e.target.checked);
            setOffset(0);
          }}
        />{' '}
        include all history
      </label>
      <p className="font-body text-sm text-off-white/55">
        Open includes unresolved failed shipping even after item resolution. PENDING /
        REQUIRES_ACTION means accepted, awaiting donor or payment-provider settlement.
      </p>
      {error && <p role="alert">{error}</p>}
      {list.records.map((record) => (
        <article key={record.id} className="btrl-panel p-3 space-y-2">
          <p>
            <a href={`/admin/donations/${record.donation_id}`} className="underline">
              Donation {record.donation_id}
            </a>{' '}
            · <span>{record.status}</span>
          </p>
          <p>
            <Amount cents={record.item_cents} label="Item return" /> ·{' '}
            <Amount cents={record.shipping_cents} label="Shipping return (outside totals)" />
          </p>
          <p className="font-mono text-xs">
            {record.id} · Stripe {record.stripe_refund_id ?? 'not bound'} · {record.created_by} ·{' '}
            {record.created_at}
          </p>
          {record.failure_reason && <p>{record.failure_reason}</p>}
          <p>
            Item: {record.resolution ?? 'unresolved'} · Shipping:{' '}
            {record.shipping_resolution ?? (record.shipping_cents ? 'unresolved' : 'not included')}
          </p>
          {['REQUESTED', 'PENDING', 'REQUIRES_ACTION'].includes(record.status) && (
            <button className="btrl-button" onClick={() => start(record, 'retry')}>
              Retry / Check Stripe
            </button>
          )}
          {record.status === 'FAILED' && record.accepted_at && !record.resolution && (
            <button className="btrl-button" onClick={() => start(record, 'item')}>
              resolve item
            </button>
          )}
          {['FAILED', 'RESOLVED'].includes(record.status) &&
            record.accepted_at &&
            record.resolution !== 'REJECTED' &&
            record.shipping_cents > 0 &&
            !record.shipping_resolution && (
              <button
                className="btrl-button btrl-button-outline"
                onClick={() => start(record, 'shipping')}
              >
                resolve shipping
              </button>
            )}
          {record.pool_shrink_data && (
            <details>
              <summary>Recorded Pool shrink / ended targets</summary>
              <PoolShrink plan={JSON.parse(record.pool_shrink_data) as PaymentRefundShrink} />
            </details>
          )}
        </article>
      ))}
      {list.records.length === 0 && <p>No Payment refunds.</p>}
      <div className="flex gap-3">
        <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
          previous
        </button>
        <span>
          {offset + list.records.length} of {list.total}
        </span>
        <button disabled={offset + 50 >= list.total} onClick={() => setOffset(offset + 50)}>
          next
        </button>
      </div>
      {action && (
        <Modal
          title={action.kind === 'retry' ? 'Retry / Check Stripe' : `Resolve ${action.kind}`}
          onClose={() => !busy && setAction(null)}
        >
          <p>
            Donation {action.record.donation_id} · Item {fmt(action.record.item_cents)} · Shipping{' '}
            {fmt(action.record.shipping_cents)} (separate, outside totals)
          </p>
          {action.kind === 'retry' ? (
            <p>
              Discover the existing Stripe refund first. An unresolved request retries with its
              original amounts and idempotency key.
            </p>
          ) : (
            <>
              <p>
                {action.kind === 'shipping'
                  ? 'Shipping never becomes Wallet credit, money totals or Pool credit.'
                  : 'Wallet recovery returns the item only; allocations stay shrunk. A chargeback permits outside return or dispute, not Wallet credit.'}
              </p>
              <select
                aria-label="resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="RETURNED_OUTSIDE_APP">Returned outside the app</option>
                {action.kind === 'shipping' ? (
                  <option value="KEPT_BY_AGREEMENT">Kept by agreement</option>
                ) : (
                  <>
                    <option
                      value="WALLET_CREDIT"
                      disabled={
                        !donationStatus || !['COMPLETED', 'REFUNDED'].includes(donationStatus)
                      }
                    >
                      Give as Wallet credit (COMPLETED / REFUNDED only)
                    </option>
                    <option value="SETTLED_BY_DISPUTE" disabled={donationStatus !== 'CHARGEBACK'}>
                      Settled by dispute (CHARGEBACK only)
                    </option>
                  </>
                )}
              </select>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button className="btrl-button" disabled={busy} onClick={confirm}>
            {action.kind === 'retry' ? 'confirm Retry / Check Stripe' : 'confirm resolution'}
          </button>
        </Modal>
      )}
    </section>
  );
}
