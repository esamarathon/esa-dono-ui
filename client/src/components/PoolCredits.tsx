import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreditApplyRequest,
  CreditAmounts,
  CreditEvent,
  CreditEventSummary,
  CreditSelection,
  PoolCategory,
} from '@dono/shared';
import { applyPoolCredits, getPoolCreditEvent, getPoolCredits } from '../api/donor';
import { apiErrorMessage } from '../types';
import ProgressBar from './ProgressBar';
const categories: PoolCategory[] = ['poll', 'goal', 'reward'];
const labels = { reward: 'Rewards', poll: 'Polls', goal: 'Goals' };
const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const categoryOf = (pick: CreditSelection): PoolCategory =>
  pick.kind === 'REWARD' ? 'reward' : pick.kind === 'GOAL' ? 'goal' : 'poll';
const cost = (pick: CreditSelection) =>
  pick.kind === 'REWARD' ? pick.quantity * pick.unit_price_cents : pick.amount_cents;

export default function PoolCredits({ donorId, wallet }: { donorId: string; wallet: number }) {
  const [summaries, setSummaries] = useState<CreditEventSummary[]>([]);
  const [eventId, setEventId] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    let active = true;
    getPoolCredits()
      .then((data) => {
        if (!active) return;
        setSummaries(data.events);
        setEventId(
          data.events.find((e) => !e.event.ended_at)?.event.id ?? data.events[0]?.event.id ?? '',
        );
        setLoaded(true);
      })
      .catch(() => {
        if (active) {
          setError('Could not load Pool credit. Reload to retry.');
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [donorId]);
  return (
    <section className="mb-10" aria-label="Use your credits">
      <h1 className="font-display text-4xl uppercase">Use your credits</h1>
      {error && <p role="alert">{error}</p>}
      {!loaded ? (
        <p>Loading Pool credit…</p>
      ) : !eventId ? (
        <>
          <p>No Pool credit yet.</p>
          <WalletFooter wallet={wallet} />
        </>
      ) : (
        <>
          {summaries.length > 1 && (
            <label>
              Event{' '}
              <select
                aria-label="Credit Event"
                disabled={locked}
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
              >
                {summaries.map((e) => (
                  <option key={e.event.id} value={e.event.id}>
                    {e.event.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <CreditPlanner
            key={`${donorId}:${eventId}`}
            eventId={eventId}
            wallet={wallet}
            onLocked={setLocked}
          />
        </>
      )}
    </section>
  );
}
function WalletFooter({ wallet }: { wallet: number }) {
  return (
    <p className="mt-5 pt-3 border-t font-data text-sm text-off-white/65">
      Wallet credit {fmt(wallet)} · for new donations only.{' '}
      <Link to="/donate" className="underline">
        Open normal draft pledge
      </Link>
    </p>
  );
}
function AmountControl({
  label,
  value,
  max,
  onSet,
}: {
  label: string;
  value: number;
  max: number;
  onSet: (cents: number) => void;
}) {
  const [input, setInput] = useState(value ? (value / 100).toFixed(2) : '');
  const [error, setError] = useState('');
  useEffect(() => {
    setInput(value ? (value / 100).toFixed(2) : '');
  }, [value]);
  const set = () => {
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(input) ||
      !Number.isSafeInteger(Math.round(Number(input) * 100))
    ) {
      setError('Enter an amount with at most two decimal places.');
      return;
    }
    setError('');
    onSet(Math.round(Number(input) * 100));
  };
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <input
        aria-label={`${label} amount`}
        type="text"
        inputMode="decimal"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-24 px-2 py-1"
      />
      <button className="btrl-button btrl-button-outline" aria-label={`Set ${label}`} onClick={set}>
        set
      </button>
      <button
        className="btrl-button btrl-button-outline"
        aria-label={`Max ${label}`}
        onClick={() => {
          setError('');
          onSet(Math.max(0, max));
        }}
      >
        max
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function CreditPlanner({
  eventId,
  wallet,
  onLocked,
}: {
  eventId: string;
  wallet: number;
  onLocked: (locked: boolean) => void;
}) {
  const [state, setState] = useState<CreditEvent | null>(null);
  const [picks, setPicks] = useState<CreditSelection[]>([]);
  const [review, setReview] = useState<CreditApplyRequest | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [changed, setChanged] = useState(false);
  const mounted = useRef(true);
  const flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    getPoolCreditEvent(eventId)
      .then((data) => {
        if (mounted.current) setState(data);
      })
      .catch(() => {
        if (mounted.current) setError('Could not load this Event’s credits.');
      });
    return () => {
      mounted.current = false;
    };
  }, [eventId]);
  useEffect(() => {
    onLocked(busy || uncertain);
  }, [busy, uncertain, onLocked]);
  const used: CreditAmounts = { reward: 0, poll: 0, goal: 0 };
  for (const pick of picks) used[categoryOf(pick)] += cost(pick);
  const remaining: CreditAmounts = { reward: 0, poll: 0, goal: 0 };
  for (const c of categories) remaining[c] = (state?.available_cents[c] ?? 0) - used[c];
  const select = (pick: CreditSelection) => {
    setSuccess('');
    setError('');
    setReview(null);
    setPicks((old) => [
      ...old.filter((p) => p.kind !== pick.kind || p.target_id !== pick.target_id),
      ...(cost(pick) > 0 ? [pick] : []),
    ]);
  };
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await getPoolCreditEvent(eventId);
      if (!mounted.current) return;
      setState(data);
      setReview(null);
      setPicks([]);
      setChanged(false);
    } catch {
      if (mounted.current) setError('Could not refresh credits. Try again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (!review || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await applyPoolCredits(eventId, review);
      if (!mounted.current) return;
      setUncertain(false);
      setReview(null);
      setPicks([]);
      setSuccess('Credits applied. Any remainder stays in its category.');
      try {
        const data = await getPoolCreditEvent(eventId);
        if (mounted.current) setState(data);
      } catch {
        if (mounted.current) {
          setState(null);
          setError(
            'Applied successfully, but the updated credit could not be loaded. Reload to continue.',
          );
        }
      }
    } catch (e) {
      if (!mounted.current) return;
      const status = (e as { response?: { status?: number } }).response?.status;
      const conflict = !!status && status >= 400 && status < 500;
      setChanged(conflict);
      setUncertain(!conflict);
      setError(
        apiErrorMessage(
          e,
          'The response was not confirmed. Retry this same batch; credit is applied at most once.',
        ),
      );
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!state)
    return (
      <>
        {error && <p role="alert">{error}</p>}
        {success && <p role="status">{success}</p>}
        {!error && <p>Loading incentives…</p>}
      </>
    );
  const quantity = (id: string) => {
    const pick = picks.find((p) => p.kind === 'REWARD' && p.target_id === id);
    return pick?.kind === 'REWARD' ? pick.quantity : 0;
  };
  const amount = (id: string) => {
    const pick = picks.find((p) => p.target_id === id);
    return pick && pick.kind !== 'REWARD' ? pick.amount_cents : 0;
  };
  const title = (pick: CreditSelection) =>
    pick.kind === 'REWARD'
      ? state.catalog.rewards.find((r) => r.id === pick.target_id)?.title
      : pick.kind === 'GOAL'
        ? state.catalog.goals.find((g) => g.id === pick.target_id)?.title
        : state.catalog.polls
            .find((p) => p.id === pick.poll_id)
            ?.options.find((o) => o.id === pick.target_id)?.label;
  const tag = (channel: { name: string } | null) => (
    <span className="ml-2 font-data text-xs uppercase text-off-white/55">
      {channel?.name ?? 'SHARED'}
    </span>
  );
  return (
    <>
      <p className="font-body text-base text-off-white/70 mb-6">
        {state.event.name} · combined from all your donations. Each credit works only on its own
        category.
      </p>
      {success && (
        <p role="status" className="mb-4">
          {success}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
        <div>
          <div
            aria-label="Mobile credit balances"
            className="lg:hidden sticky top-0 z-30 btrl-panel-dark p-3 mb-4 flex flex-wrap gap-3"
          >
            {categories.map((c) => (
              <span key={c}>
                {labels[c]} {fmt(remaining[c])} left
              </span>
            ))}
            <button
              onClick={() =>
                document.getElementById('credit-panel')?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              review ↓
            </button>
          </div>
          <fieldset
            disabled={!!review || busy || !!state.event.ended_at}
            className={review ? 'opacity-50' : ''}
          >
            <section aria-label="Polls incentives" className="mb-8">
              <h2 className="font-display text-3xl mb-4">Polls</h2>
              {state.catalog.polls.map((p) => (
                <article key={p.id} className="btrl-panel p-4 mb-3">
                  <p className="font-data font-bold text-lg">
                    {p.title}
                    {tag(p.channel)}
                  </p>
                  {p.options.map((o) => (
                    <div key={o.id} className="mt-3">
                      <p>
                        {o.label} · {fmt(o.votes_cents)} allocated
                      </p>
                      <ProgressBar
                        value={o.votes_cents}
                        max={p.total_votes_cents}
                        animateOnChange={false}
                      />
                      <AmountControl
                        label={o.label}
                        value={amount(o.id)}
                        max={remaining.poll + amount(o.id)}
                        onSet={(cents) =>
                          select({
                            kind: 'POLL_VOTE',
                            target_id: o.id,
                            poll_id: p.id,
                            amount_cents: cents,
                          })
                        }
                      />
                    </div>
                  ))}
                </article>
              ))}
            </section>
            <section aria-label="Goals incentives" className="mb-8">
              <h2 className="font-display text-3xl mb-4">Goals</h2>
              {state.catalog.goals.map((g) => (
                <article key={g.id} className="btrl-panel p-4 mb-3">
                  <p className="font-data font-bold text-lg">
                    {g.title}
                    {tag(g.channel)}
                  </p>
                  <p>
                    {fmt(g.current_cents)} / {fmt(g.target_cents)} allocated
                  </p>
                  <ProgressBar
                    value={g.current_cents}
                    max={g.target_cents}
                    animateOnChange={false}
                  />
                  <AmountControl
                    label={g.title}
                    value={amount(g.id)}
                    max={remaining.goal + amount(g.id)}
                    onSet={(cents) =>
                      select({ kind: 'GOAL', target_id: g.id, amount_cents: cents })
                    }
                  />
                </article>
              ))}
            </section>
            <section aria-label="Rewards incentives" className="mb-8">
              <h2 className="font-display text-3xl mb-4">Rewards</h2>
              {state.catalog.rewards.map((r) => (
                <article key={r.id} className="btrl-panel p-4 mb-3">
                  <p className="font-data font-bold">
                    {r.title} · {fmt(r.cost_cents)}
                    {tag(r.channel)}
                  </p>
                  <p>{r.remaining === null ? 'Unlimited stock' : `${r.remaining} left`}</p>
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      aria-label={`Remove ${r.title}`}
                      disabled={!quantity(r.id)}
                      onClick={() =>
                        select({
                          kind: 'REWARD',
                          target_id: r.id,
                          unit_price_cents: r.cost_cents,
                          reward_type: r.type,
                          quantity: quantity(r.id) - 1,
                        })
                      }
                    >
                      −
                    </button>
                    <output aria-label={`${r.title} quantity`}>{quantity(r.id)}</output>
                    <button
                      aria-label={`Add ${r.title}`}
                      disabled={
                        remaining.reward < r.cost_cents ||
                        (r.remaining !== null && quantity(r.id) >= r.remaining)
                      }
                      onClick={() =>
                        select({
                          kind: 'REWARD',
                          target_id: r.id,
                          unit_price_cents: r.cost_cents,
                          reward_type: r.type,
                          quantity: quantity(r.id) + 1,
                        })
                      }
                    >
                      +
                    </button>
                  </div>
                </article>
              ))}
            </section>
          </fieldset>
        </div>
        <aside
          id="credit-panel"
          aria-label="Credit balances"
          className="btrl-panel-dark p-5 lg:sticky lg:top-4"
        >
          {categories.map((c) => (
            <div key={c} className="mb-4">
              <p className={remaining[c] < 0 ? 'text-red' : ''}>
                {labels[c]} <strong>{fmt(remaining[c])}</strong> left
              </p>
              <meter
                aria-label={`${labels[c]} credit remaining`}
                value={Math.max(0, remaining[c])}
                max={Math.max(1, state.available_cents[c])}
                className="w-full"
              />
              {state.reasons[c] && (
                <p className="font-body text-sm mt-2">
                  {state.reasons[c]}{' '}
                  {state.outstanding_cents[c] !== state.available_cents[c] &&
                    `${fmt(state.outstanding_cents[c])} recorded Pool credit.`}
                </p>
              )}
            </div>
          ))}
          {categories.some((c) => remaining[c] < 0) && (
            <p role="alert">Selections exceed category credit. Reduce the amount or use max.</p>
          )}
          {error && (
            <p role="alert" className="mb-3">
              {error}
            </p>
          )}
          {review ? (
            <>
              <ul aria-label="Reviewed credit picks">
                {review.selections.map((pick) => (
                  <li key={`${pick.kind}:${pick.target_id}`}>
                    {title(pick)} {pick.kind === 'REWARD' ? `× ${pick.quantity}` : ''} ·{' '}
                    {fmt(cost(pick))}
                  </li>
                ))}
              </ul>
              <p className="font-body text-sm py-3">
                No payment. Incentive totals change; money totals don’t.
              </p>
              <button
                className="btrl-button btrl-button-outline"
                disabled={busy || uncertain}
                onClick={() => {
                  setReview(null);
                  setError('');
                }}
              >
                Edit
              </button>
              <button className="btrl-button" disabled={busy || changed} onClick={apply}>
                {busy ? 'Applying…' : 'Apply credits'}
              </button>
            </>
          ) : (
            <button
              className="btrl-button w-full"
              disabled={
                !picks.length ||
                categories.some((c) => remaining[c] < 0) ||
                busy ||
                !!state.event.ended_at ||
                changed
              }
              onClick={() => {
                setError('');
                setReview({
                  idempotency_key: crypto.randomUUID(),
                  reviewed_credit_cents: { ...state.available_cents },
                  selections: picks,
                });
              }}
            >
              Review {picks.length || ''}
              {picks.length ? ` pick${picks.length === 1 ? '' : 's'}` : ''}
            </button>
          )}
          {changed && (
            <button className="btrl-button mt-3" disabled={busy} onClick={refresh}>
              Refresh and review again
            </button>
          )}
          {uncertain && (
            <p className="font-body text-sm mt-2">
              Retry Apply credits before changing this batch.
            </p>
          )}
          <WalletFooter wallet={wallet} />
        </aside>
      </div>
      <details className="mt-5">
        <summary>Where your credit came from</summary>
        <ul>
          {state.history.map((row) => (
            <li key={row.id} className="mt-3">
              {labels[row.category]} · {fmt(row.amount_cents)} from {row.origin.title} ·{' '}
              {new Date(row.created_at).toLocaleDateString()} · donation {row.donation_id} ·{' '}
              {fmt(row.remaining_cents)} remaining
              {row.redemptions.map((r) => (
                <p key={r.id}>
                  {fmt(r.amount_cents)} applied {new Date(r.created_at).toLocaleDateString()}
                  {r.reversed ? ' · reversed; original credit restored where eligible' : ''}
                </p>
              ))}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
