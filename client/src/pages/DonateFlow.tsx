import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useDraftPledge, type IncentiveCategory } from '../context/DraftPledgeContext';
import { getPublicEvent } from '../api/events';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import ShareLinkButton from '../components/ShareLinkButton';
import RewardList from '../components/incentives/RewardList';
import PollList from '../components/incentives/PollList';
import GoalList from '../components/incentives/GoalList';
import PledgeReview from '../components/PledgeReview';
import { sanitizeMoneyInput } from '../utils/money';
import type { PublicEvent } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
const TABS: IncentiveCategory[] = ['rewards', 'polls', 'goals'];
export function LegacyIncentiveRedirect({ tab }: { tab: IncentiveCategory }) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('tab', tab);
  return <Navigate replace to={`/donate?${search}${location.hash}`} />;
}

export default function DonateFlow() {
  const flow = useDraftPledge();
  const {
    draft,
    pending,
    paymentChecking,
    plan,
    busy,
    loading,
    channels,
    selectedChannelId,
    refreshEditable,
  } = flow;
  const location = useLocation();
  const { eventSlug, channelSlug } = useParams<{ eventSlug?: string; channelSlug?: string }>();
  const [amount, setAmount] = useState(draft ? (draft.amountCents / 100).toFixed(2) : '10');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkWarning, setLinkWarning] = useState<string | null>(null);
  const [slugEvent, setSlugEvent] = useState<PublicEvent | null>(null);
  const consumedSelection = useRef('');
  const consumedTab = useRef('');
  const amountCents = draft?.amountCents;
  const pendingToken = draft?.pendingToken;
  const draftChannelId = draft?.channelId;
  const hasDraft = draft !== null;
  const lastStep = draft?.lastStep;
  const selectedTab = draft?.tab;

  useEffect(() => {
    void refreshEditable();
  }, [refreshEditable]);
  useEffect(() => {
    if (amountCents !== undefined) setAmount((amountCents / 100).toFixed(2));
  }, [amountCents]);
  useEffect(() => {
    if (pendingToken || !eventSlug) {
      setSlugEvent(null);
      setLinkError(null);
      return;
    }
    let active = true;
    setLinkError(null);
    getPublicEvent(eventSlug)
      .then((e) => {
        if (active) setSlugEvent(e);
      })
      .catch(() => {
        if (active) {
          if (hasDraft && !draftChannelId)
            setLinkWarning("That event isn't open for donations. Choose another Channel.");
          else setLinkError("That event isn't open for donations.");
        }
      });
    return () => {
      active = false;
    };
  }, [eventSlug, pendingToken, hasDraft, draftChannelId]);
  useEffect(() => {
    if (draft?.pendingToken || busy || loading) return;
    const params = new URLSearchParams(location.search);
    const key = `${location.pathname}${location.search}`;
    if (consumedSelection.current !== key) {
      let target: string | undefined;
      if (eventSlug) {
        if (!slugEvent || slugEvent.slug !== eventSlug) return;
        target = channelSlug
          ? slugEvent.channels.find((c) => c.slug === channelSlug)?.id
          : slugEvent.channels.length === 1
            ? slugEvent.channels[0]?.id
            : (slugEvent.primary_channel_id ?? undefined);
        if (channelSlug && !target) {
          consumedSelection.current = key;
          if (draft && !draft.channelId)
            setLinkWarning("That Channel isn't open for donations. Choose another Channel.");
          else setLinkError("That channel isn't open for donations.");
          return;
        }
      } else if (params.has('channel')) {
        target = channels.find((c) => c.id === params.get('channel'))?.id;
        if (!target) setLinkWarning('That channel is no longer available.');
      } else {
        target =
          flow.rewards.find((r) => r.id === params.get('reward'))?.channel_id ??
          flow.polls.find((p) => p.id === params.get('poll'))?.channel_id ??
          flow.goals.find((g) => g.id === params.get('goal'))?.channel_id ??
          undefined;
      }
      consumedSelection.current = key;
      if (target)
        flow.selectChannel(target, eventSlug ? location.pathname : '/donate', eventSlug ?? null);
    }
    if (!flow.pendingChannelId) {
      const warning = flow.prefillFromLink(params);
      if (warning) setLinkWarning(warning);
      const tab =
        params.get('tab') ??
        (params.has('poll')
          ? 'polls'
          : params.has('goal')
            ? 'goals'
            : params.has('reward')
              ? 'rewards'
              : null);
      if (draft && tab && TABS.includes(tab as IncentiveCategory) && consumedTab.current !== key) {
        consumedTab.current = key;
        flow.setTab(tab as IncentiveCategory);
        if (params.has('tab') && !params.has('step') && draft.lastStep === 'review')
          flow.setStep('browse');
      }
    }
  }, [
    location.pathname,
    location.search,
    eventSlug,
    channelSlug,
    slugEvent,
    channels,
    loading,
    busy,
    draft,
    flow,
  ]);
  useEffect(() => {
    if (lastStep !== 'browse' || selectedTab !== 'polls') return;
    const pollId = new URLSearchParams(location.search).get('poll');
    if (!pollId) return;
    const timer = setTimeout(
      () =>
        document
          .getElementById(`poll-${pollId}`)
          ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
      50,
    );
    return () => clearTimeout(timer);
  }, [lastStep, selectedTab, location.search]);

  const errors = (
    <>
      {flow.error && (
        <p role="alert" className="font-data text-sm mb-4" style={{ color: 'var(--red)' }}>
          {flow.error}
        </p>
      )}
      {flow.notices.map((notice, index) => (
        <p key={index} role="status" className="font-data text-sm text-d-yellow mb-2">
          {notice}
        </p>
      ))}
    </>
  );
  // Pending FIRST: no picker, draft fields, links, prices or repairs can edit this review.
  if (draft?.pendingToken)
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h2 className="font-display text-3xl uppercase mb-4">Pending pledge — read-only review</h2>
        {paymentChecking && <p role="status">Checking payment before loading your draft...</p>}
        {errors}
        {pending ? (
          <>
            <p className="font-data text-sm mb-4">
              {pending.payment_state === 'PAYMENT_REVIEW'
                ? 'Payment received as Wallet credit. The original incentives were not fulfilled. This payment needs admin review.'
                : pending.payment_state === 'LEGACY_PAID'
                  ? 'Old-shape payment received as Wallet credit. The original incentives were not fulfilled.'
                  : pending.payment_state === 'OPEN'
                    ? 'Continue the same checkout, or cancel it before editing or switching Channel.'
                    : 'Payment status is not confirmed. Editing and new checkout are blocked.'}
            </p>
            {pending.format === 'POOLED' ? (
              <PledgeReview
                plan={pending.plan}
                defaultGoal={flow.defaultGoal}
                previewError={flow.previewError}
              />
            ) : (
              <section aria-label="Legacy review">
                <p>Legacy pledge — original items are read-only; no pooled pledge amount.</p>
                {pending.items.map((item, index) => (
                  <p key={index} className="font-data text-sm">
                    {item.kind}: {item.target_id} — {fmt(item.amount_cents)}
                  </p>
                ))}
              </section>
            )}
            <p className="font-data mb-2">Channel: {pending.channel_id ?? 'unassigned'}</p>
            <p className="font-data mb-2">Display name: {pending.display_name || 'Anonymous'}</p>
            <p className="font-body mb-4">Message: {pending.comment || '(none)'}</p>
            {pending.can_continue && (
              <button
                className="btrl-button mr-3"
                disabled={busy}
                onClick={() => void flow.continuePayment()}
              >
                continue to payment
              </button>
            )}
            {pending.format === 'POOLED' &&
              ['OPEN', 'READY', 'UNKNOWN'].includes(pending.payment_state) && (
                <button
                  className="btrl-button btrl-button-outline mr-3"
                  disabled={busy}
                  onClick={() => void flow.editPending()}
                >
                  edit — cancel payment first
                </button>
              )}
          </>
        ) : null}
        <button
          className="btrl-button btrl-button-outline"
          disabled={busy || paymentChecking}
          onClick={() => void flow.checkPayment()}
        >
          check payment
        </button>
      </div>
    );
  if (loading) return <LoadingSpinner />;
  if (linkError)
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p role="alert">{linkError}</p>
        <Link to="/donate" className="btrl-button">
          back to donations
        </Link>
      </div>
    );

  const cents = Math.round(Number(amount) * 100);
  const validAmount =
    !!amount && Number.isSafeInteger(cents) && cents >= 100 && cents <= 2147483647;
  const step = draft?.lastStep ?? 'amount';
  const over = !!plan && Object.values(plan.overage_cents).some((v) => v > 0);
  const tab = draft?.tab ?? 'rewards';
  const confirm = (next: 'browse' | 'review') => flow.confirmAmount(cents, next);
  return (
    <div className="max-w-3xl mx-auto p-8">
      {flow.success !== null && (
        <p role="status" className="font-data text-d-yellow mb-4">
          Your {fmt(flow.success)} donation went through.
        </p>
      )}
      {linkWarning && (
        <p role="status" className="font-data text-d-yellow mb-4">
          {linkWarning}
        </p>
      )}
      {errors}
      <div className="btrl-panel p-4 mb-6">
        <p className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-2">Channel</p>
        {channels.length === 0 ? (
          <p>No channels are open right now.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <div key={c.id} className="flex items-center gap-1">
                <button
                  disabled={busy}
                  onClick={() => flow.selectChannel(c.id)}
                  className="font-data font-bold text-sm uppercase px-4 py-2 rounded-sm"
                  style={{
                    background:
                      selectedChannelId === c.id ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)',
                    color: selectedChannelId === c.id ? 'black' : undefined,
                  }}
                >
                  {c.name}
                </button>
                <ShareLinkButton path={`/donate?channel=${c.id}`} />
              </div>
            ))}
          </div>
        )}
        {!selectedChannelId && (
          <p className="font-body text-sm mt-2">Choose a Channel before continuing.</p>
        )}
      </div>
      {flow.pendingChannelId && (
        <Modal title="switch Channel?" onClose={flow.cancelChannelSwitch}>
          <p className="font-body text-sm mb-4">
            Switching removes your current Channel's selections. Shared selections and your pledge
            amount stay.
          </p>
          <button
            className="btrl-button btrl-button-outline mr-3"
            onClick={flow.cancelChannelSwitch}
          >
            cancel
          </button>
          <button className="btrl-button" onClick={flow.confirmChannelSwitch}>
            switch &amp; clear those items
          </button>
        </Modal>
      )}
      {step === 'amount' ? (
        <div className="btrl-panel p-6">
          <h2 className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-2">
            1 · how much?
          </h2>
          <p className="font-body text-sm text-off-white/60 mb-4">
            Your donation counts in full toward rewards, and polls, and fund goals.
          </p>
          <div className="flex gap-2 mb-4">
            {[5, 10, 25, 50].map((value) => (
              <button
                key={value}
                className="btrl-button btrl-button-outline"
                onClick={() => setAmount(String(value))}
              >
                ${value}
              </button>
            ))}
          </div>
          <label className="font-data text-sm">
            Pledge amount ($)
            <input
              aria-label="Pledge amount ($)"
              type="number"
              min="1"
              step="0.01"
              className="block w-full px-3 py-2 mt-1"
              value={amount}
              onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
            />
          </label>
          {!validAmount && (
            <p className="font-data text-sm mt-2" role="alert">
              Minimum pledge amount is $1.00.
            </p>
          )}
          <div className="flex flex-wrap gap-3 mt-6">
            <button
              className="btrl-button"
              disabled={!validAmount || !selectedChannelId || busy}
              onClick={() => confirm('browse')}
            >
              choose incentives →
            </button>
            <button
              className="btrl-button btrl-button-outline"
              disabled={!validAmount || !selectedChannelId || busy}
              onClick={() => confirm('review')}
            >
              just donate {validAmount ? fmt(cents) : ''} + message
            </button>
          </div>
        </div>
      ) : step === 'browse' ? (
        <>
          <div
            className="sticky top-0 z-30 btrl-panel-dark p-3 mb-4 shadow-lg"
            style={{ background: 'var(--dark-gray)' }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="font-data text-d-yellow"
                disabled={busy}
                onClick={() => flow.setStep('amount')}
              >
                edit amount {fmt(draft!.amountCents)}
              </button>
              <div className="flex gap-3 flex-1">
                {(['reward', 'poll', 'goal'] as const).map((category) => (
                  <div
                    key={category}
                    role="meter"
                    aria-label={`${category} Pool`}
                    aria-valuemin={0}
                    aria-valuemax={draft!.amountCents}
                    aria-valuenow={plan?.usage_cents[category] ?? 0}
                    className="flex-1 font-data text-sm"
                    style={{ color: plan?.overage_cents[category] ? 'var(--red)' : undefined }}
                  >
                    {category} Pool
                    <br />
                    {fmt(plan?.usage_cents[category] ?? 0)} / {fmt(draft!.amountCents)}
                    <div className="h-1 mt-1" style={{ background: 'rgba(239,238,236,.16)' }}>
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.min(100, ((plan?.usage_cents[category] ?? 0) / draft!.amountCents) * 100)}%`,
                          background: plan?.overage_cents[category]
                            ? 'var(--red)'
                            : 'var(--d-yellow)',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <button
                className="btrl-button"
                disabled={over || !plan || busy || !selectedChannelId}
                onClick={() => void flow.review()}
              >
                review →
              </button>
            </div>
            {over && (
              <div role="alert" className="font-data text-sm mt-3" style={{ color: 'var(--red)' }}>
                {(['reward', 'poll', 'goal'] as const)
                  .filter((category) => plan!.overage_cents[category] > 0)
                  .map((category) => (
                    <p key={category}>
                      Your {category} selections add up to {fmt(plan!.usage_cents[category])}, more
                      than your {fmt(draft!.amountCents)} pledge.
                    </p>
                  ))}
                <button
                  className="btrl-button mt-2"
                  onClick={() =>
                    flow.confirmAmount(Math.max(...Object.values(plan!.usage_cents)), 'browse')
                  }
                >
                  raise my donation to {fmt(Math.max(...Object.values(plan!.usage_cents)))}
                </button>
              </div>
            )}
          </div>
          <div
            role="tablist"
            aria-label="Incentive categories"
            className="flex justify-center gap-2 mb-6"
          >
            {TABS.map((t) => (
              <button
                role="tab"
                aria-selected={tab === t}
                key={t}
                className="font-data font-bold text-sm uppercase px-4 py-2 rounded-sm"
                style={{
                  background: tab === t ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)',
                  color: tab === t ? 'black' : undefined,
                }}
                onClick={() => flow.setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === 'rewards' ? <RewardList /> : tab === 'polls' ? <PollList /> : <GoalList />}
        </>
      ) : (
        <div className="btrl-panel p-6">
          <h2 className="font-mono text-sm tracking-widest uppercase text-d-yellow mb-4">
            3 · review
          </h2>
          <button
            className="btrl-button btrl-button-outline mb-4"
            disabled={busy}
            onClick={() => flow.setStep('browse')}
          >
            edit selections
          </button>
          <button
            className="btrl-button btrl-button-outline mb-4 ml-3"
            disabled={busy}
            onClick={() => flow.setStep('amount')}
          >
            edit amount
          </button>
          {plan && (
            <PledgeReview
              plan={plan}
              selections={draft!.selections}
              defaultGoal={flow.defaultGoal}
              previewError={flow.previewError}
            />
          )}
          {!plan || over ? (
            <p role="alert">
              Selections exceed the pledge amount or are invalid. Edit selections or raise the
              amount before paying.
            </p>
          ) : null}
          <label className="block font-data text-sm mb-3">
            Email address (optional)
            <input
              type="email"
              aria-label="Email address (optional)"
              className="block w-full px-3 py-2 mt-1"
              value={flow.email}
              disabled={busy}
              onChange={(e) => flow.setEmail(e.target.value)}
            />
          </label>
          <label className="block font-data text-sm mb-3">
            Display name (optional; empty = Anonymous)
            <input
              aria-label="Display name"
              className="block w-full px-3 py-2 mt-1"
              maxLength={60}
              value={draft!.displayName}
              disabled={busy}
              onChange={(e) => flow.setDisplayName(e.target.value)}
            />
          </label>
          <label className="block font-data text-sm mb-3">
            Message (optional; 500 characters maximum)
            <textarea
              aria-label="Message"
              className="block w-full px-3 py-2 mt-1"
              rows={3}
              maxLength={500}
              value={draft!.comment}
              disabled={busy}
              onChange={(e) => flow.setComment(e.target.value)}
            />
          </label>
          <p className="font-mono text-sm mb-3">
            {draft!.comment.length}/500 · Messages are checked by the blocked-word filter.
          </p>
          {!flow.reviewReady && !busy && (
            <button
              className="btrl-button btrl-button-outline mb-3"
              onClick={() => void flow.review()}
            >
              refresh review
            </button>
          )}
          {flow.corrected && (
            <button className="btrl-button mb-3" onClick={flow.confirmCorrected}>
              confirm corrected review
            </button>
          )}
          <button
            className="btrl-button w-full"
            disabled={
              busy || !flow.reviewReady || !plan || over || flow.corrected || !selectedChannelId
            }
            onClick={() => void flow.checkout()}
          >
            {busy
              ? 'checking review...'
              : `confirm & pay ${fmt(plan?.new_money_cents ?? 0)}${plan?.requires_shipping ? ' + shipping' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}
