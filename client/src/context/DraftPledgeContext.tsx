import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { planPledge, type PledgePlan, type PledgeSelection } from '@dono/shared';
import { getRewards } from '../api/rewards';
import { getPolls } from '../api/polls';
import { getGoals } from '../api/goals';
import { getChannels } from '../api/channels';
import { getDonor } from '../api/donor';
import {
  createPledge,
  reconcilePledge,
  cancelPledge,
  continuePledge,
  getDefaultGoalPreview,
} from '../api/pledge';
import { isSessionActive } from '../utils/authToken';
import { INCENTIVES_POLL_MS, DEFAULT_VOTE_AMOUNT, DEFAULT_GOAL_AMOUNT } from '../config';
import {
  apiErrorMessage,
  type DraftSelection,
  type Reward,
  type Poll,
  type Goal,
  type Channel,
  type Pledge,
} from '../types';

export type DraftStep = 'amount' | 'browse' | 'review';
export type IncentiveCategory = 'rewards' | 'polls' | 'goals';
export interface DraftPledge {
  id: string;
  updatedAt: number;
  amountCents: number;
  selections: DraftSelection[];
  channelId: string | null;
  eventSlug: string | null;
  path: string;
  comment: string;
  displayName: string;
  lastStep: DraftStep;
  tab: IncentiveCategory;
  pendingToken: string | null;
}
const STORAGE_KEY = 'donation_draft_v1';
const TTL = 24 * 60 * 60 * 1000;
const EMAIL_KEY = 'last_donor_email';
const NAME_KEY = 'last_donor_display_name';

function parseDraft(raw: string | null): DraftPledge | null {
  try {
    if (!raw) return null;
    const d: DraftPledge = JSON.parse(raw);
    if (
      !d ||
      typeof d.id !== 'string' ||
      !d.id ||
      !Number.isSafeInteger(d.updatedAt) ||
      !Number.isSafeInteger(d.amountCents) ||
      d.amountCents < 100 ||
      d.amountCents > 2147483647 ||
      !Array.isArray(d.selections) ||
      !['amount', 'browse', 'review'].includes(d.lastStep) ||
      !['rewards', 'polls', 'goals'].includes(d.tab) ||
      typeof d.path !== 'string' ||
      !/^\/donate(?:\/[a-z0-9-]+){0,2}$/.test(d.path) ||
      typeof d.comment !== 'string' ||
      typeof d.displayName !== 'string' ||
      (d.channelId !== null && typeof d.channelId !== 'string') ||
      (d.eventSlug !== null && typeof d.eventSlug !== 'string') ||
      (d.pendingToken !== null && typeof d.pendingToken !== 'string')
    )
      return null;
    if (
      d.selections.some(
        (i) =>
          !i ||
          !['REWARD', 'GOAL', 'POLL_VOTE', 'POLL_CUSTOM'].includes(i.kind) ||
          typeof i.target_id !== 'string' ||
          !Number.isSafeInteger(i.amount_cents) ||
          i.amount_cents < 100 ||
          !Number.isSafeInteger(i.insertion_order) ||
          i.insertion_order! < 0 ||
          (i.quantity !== undefined && (!Number.isSafeInteger(i.quantity) || i.quantity < 1)),
      )
    )
      return null;
    // A pending payment MUST be reconciled even after the local draft's TTL.
    if (!d.pendingToken && Date.now() - d.updatedAt >= TTL) return null;
    return d;
  } catch {
    return null;
  }
}
function loadDraft() {
  sessionStorage.removeItem('donation_cart_v1');
  const draft = parseDraft(localStorage.getItem(STORAGE_KEY));
  if (!draft) localStorage.removeItem(STORAGE_KEY);
  return draft;
}

/** Keep stable catalog/option order while replacing live records. */
function mergeById<T extends { id: string }>(old: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((i) => [i.id, i]));
  return [
    ...old.filter((i) => byId.has(i.id)).map((i) => byId.get(i.id)!),
    ...fresh.filter((i) => !old.some((o) => o.id === i.id)),
  ];
}

interface DraftContextValue {
  draft: DraftPledge | null;
  selections: DraftSelection[];
  rewards: Reward[];
  polls: Poll[];
  goals: Goal[];
  channels: Channel[];
  loading: boolean;
  selectedChannelId: string | null;
  pendingChannelId: string | null;
  selectChannel: (id: string, path?: string, eventSlug?: string | null) => void;
  confirmChannelSwitch: () => void;
  cancelChannelSwitch: () => void;
  confirmAmount: (amount: number, step: DraftStep) => void;
  setStep: (step: DraftStep) => void;
  setTab: (tab: IncentiveCategory) => void;
  addSelection: (item: DraftSelection) => void;
  removeSelection: (kind: DraftSelection['kind'], id: string) => void;
  incrementRewardQuantity: (id: string) => void;
  decrementRewardQuantity: (id: string) => void;
  email: string;
  setEmail: (email: string) => void;
  setComment: (comment: string) => void;
  setDisplayName: (name: string) => void;
  plan: PledgePlan | null;
  notices: string[];
  error: string;
  busy: boolean;
  reviewReady: boolean;
  pending: Pledge | null;
  paymentChecking: boolean;
  success: number | null;
  defaultGoal: { id: string; title: string } | null;
  previewError: boolean;
  corrected: boolean;
  confirmCorrected: () => void;
  review: () => Promise<void>;
  refreshEditable: () => Promise<void>;
  checkout: () => Promise<void>;
  checkPayment: () => Promise<void>;
  editPending: () => Promise<void>;
  continuePayment: () => Promise<void>;
  prefillFromLink: (params: URLSearchParams) => string | null;
  paymentObserver: (token: string) => (pledge: Pledge) => void;
}
const DraftContext = createContext<DraftContextValue | null>(null);
// Context hooks share the provider module; they do not define render components.
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalDraftPledge() {
  return useContext(DraftContext);
}
// eslint-disable-next-line react-refresh/only-export-components
export function useDraftPledge() {
  const ctx = useOptionalDraftPledge();
  if (!ctx) throw new Error('useDraftPledge must be used within DraftPledgeProvider');
  return ctx;
}

export function DraftPledgeProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(loadDraft);
  const current = useRef(draft);
  const epoch = useRef(0);
  const paymentRequest = useRef(0);
  const mounted = useRef(true);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reviewReady, setReviewReady] = useState(false);
  const [externalRevision, setExternalRevision] = useState(0);
  const [pending, setPending] = useState<Pledge | null>(null);
  const [paymentChecking, setPaymentChecking] = useState(!!draft?.pendingToken);
  const [success, setSuccess] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [allRewards, setRewards] = useState<Reward[]>([]);
  const [allPolls, setPolls] = useState<Poll[]>([]);
  const [allGoals, setGoals] = useState<Goal[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelId, setChannelId] = useState<string | null>(draft?.channelId ?? null);
  const channelRef = useRef(channelId);
  const routeRef = useRef({ path: draft?.path ?? '/donate', eventSlug: draft?.eventSlug ?? null });
  const [pendingChannel, setPendingChannel] = useState<{
    id: string;
    path: string;
    eventSlug: string | null;
  } | null>(null);
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '');
  const [wallet, setWallet] = useState<number | null>(null);
  const [defaultGoal, setDefaultGoal] = useState<{ id: string; title: string } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [correctedPlan, setCorrectedPlan] = useState<PledgePlan | null>(null);
  const [corrected, setCorrected] = useState(false);
  const consumedLinks = useRef(new Set<string>());

  const store = useCallback((next: DraftPledge | null) => {
    current.current = next;
    setDraft(next);
    channelRef.current = next?.channelId ?? null;
    setChannelId(channelRef.current);
    if (next) {
      routeRef.current = { path: next.path, eventSlug: next.eventSlug };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else localStorage.removeItem(STORAGE_KEY);
  }, []);
  // Every async operation captures all four guards, not just a token or id.
  const guard = useCallback(() => {
    const before = current.current;
    const sessionEpoch = epoch.current;
    return () =>
      mounted.current &&
      sessionEpoch === epoch.current &&
      before?.id === current.current?.id &&
      before?.updatedAt === current.current?.updatedAt &&
      before?.pendingToken === current.current?.pendingToken;
  }, []);
  const edit = useCallback(
    (patch: Partial<DraftPledge>) => {
      const d = current.current;
      if (!d || d.pendingToken || flight.current) return;
      setError('');
      if ('selections' in patch || 'amountCents' in patch || 'channelId' in patch) {
        setCorrectedPlan(null);
        setCorrected(false);
        setReviewReady(false);
      }
      store({ ...d, ...patch, updatedAt: Math.max(Date.now(), d.updatedAt + 1) });
    },
    [store],
  );
  const clearLocal = useCallback(() => {
    epoch.current += 1;
    flight.current = false;
    setBusy(false);
    setPending(null);
    setPaymentChecking(false);
    setWallet(null);
    setReviewReady(false);
    setCorrectedPlan(null);
    setCorrected(false);
    setPendingChannel(null);
    setSuccess(null);
    setError('');
    setNotices([]);
    consumedLinks.current.clear();
    store(null);
  }, [store]);

  useEffect(() => {
    mounted.current = true;
    const storage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key === 'donor_session_active') {
        session();
        return;
      }
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      // Queued events can describe an earlier write or removal. Read the actual
      // durable value before deciding which revision wins, including deletion.
      const raw = localStorage.getItem(STORAGE_KEY);
      const next = parseDraft(raw);
      if (raw !== null && !next) return;
      if (next && current.current && JSON.stringify(next) === JSON.stringify(current.current))
        return;
      if (next && current.current && next.updatedAt < current.current.updatedAt) {
        // A delayed write can already have replaced storage. Restore the winner.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current.current));
        return;
      }
      epoch.current += 1;
      flight.current = false;
      setBusy(false);
      setReviewReady(false);
      setExternalRevision((v) => v + 1);
      setPending(null);
      setPaymentChecking(!!next?.pendingToken);
      setCorrectedPlan(null);
      setCorrected(false);
      setNotices([]);
      setError('');
      setSuccess(null);
      setPendingChannel(null);
      // A storage event already wrote storage. Never echo it into another tab.
      current.current = next;
      setDraft(next);
      channelRef.current = next?.channelId ?? null;
      setChannelId(channelRef.current);
      if (next) routeRef.current = { path: next.path, eventSlug: next.eventSlug };
    };
    const session = () => {
      epoch.current += 1;
      if (!isSessionActive()) clearLocal();
      else {
        setWallet(null);
        setReviewReady(false);
        flight.current = false;
        setBusy(false);
        setExternalRevision((v) => v + 1);
      }
    };
    window.addEventListener('storage', storage);
    window.addEventListener('donor-token-changed', session);
    const timer = setInterval(() => {
      const d = current.current;
      if (d && !d.pendingToken && !flight.current && Date.now() - d.updatedAt >= TTL) clearLocal();
    }, 60000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener('donor-token-changed', session);
    };
  }, [clearLocal]);

  useEffect(() => {
    if (!draft || draft.pendingToken) return;
    const valid = guard();
    const timer = setTimeout(
      () => {
        if (valid() && !flight.current) clearLocal();
      },
      Math.max(0, TTL - (Date.now() - draft.updatedAt)),
    );
    return () => clearTimeout(timer);
  }, [draft, guard, clearLocal]);

  const applyPayment = useCallback(
    (pledge: Pledge) => {
      const d = current.current;
      if (
        !d ||
        pledge.pledge_token !== d.pendingToken ||
        (pledge.format === 'POOLED' && pledge.draft_id !== d.id)
      )
        return;
      setPending(pledge);
      setPaymentChecking(false);
      if (pledge.payment_state === 'FULFILLED') {
        setSuccess(pledge.format === 'POOLED' ? pledge.pledge_amount_cents : d.amountCents);
        store(null);
        setPending(null);
      } else if (
        pledge.payment_state === 'NON_PAYMENT' &&
        pledge.can_edit &&
        pledge.format === 'POOLED'
      ) {
        setPending(null);
        store({
          ...d,
          pendingToken: null,
          lastStep: 'review',
          updatedAt: Math.max(Date.now(), d.updatedAt + 1),
        });
        setNotices(['No payment was taken. Non-payment confirmed; your draft is editable.']);
      }
    },
    [store],
  );
  const paymentObserver = useCallback(
    (token: string) => {
      const valid = guard();
      return (pledge: Pledge) => {
        if (valid() && current.current?.pendingToken === token) {
          paymentRequest.current += 1;
          applyPayment(pledge);
        }
      };
    },
    [guard, applyPayment],
  );
  const paymentAction = useCallback(
    async (action: typeof reconcilePledge, redirect = false) => {
      const token = current.current?.pendingToken;
      if (!token || flight.current) return;
      const unchanged = guard();
      const request = ++paymentRequest.current;
      const valid = () => unchanged() && request === paymentRequest.current;
      const operationEpoch = epoch.current;
      flight.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await action(token);
        if (!valid()) return;
        applyPayment(result);
        if (redirect && result.can_continue && result.donate_url)
          window.location.assign(result.donate_url);
      } catch (e) {
        if (!valid()) return;
        const response = (e as { response?: { data?: { pledge?: Pledge } } }).response?.data
          ?.pledge;
        if (response) applyPayment(response);
        setError(
          apiErrorMessage(
            e,
            'Payment status is not confirmed. Editing and new checkout are blocked.',
          ),
        );
      } finally {
        if (mounted.current && epoch.current === operationEpoch) {
          flight.current = false;
          setBusy(false);
          setPaymentChecking(false);
        }
      }
    },
    [guard, applyPayment],
  );
  const checkPayment = useCallback(() => paymentAction(reconcilePledge), [paymentAction]);
  const editPending = useCallback(() => paymentAction(cancelPledge), [paymentAction]);
  const continuePayment = useCallback(() => paymentAction(continuePledge, true), [paymentAction]);

  useEffect(() => {
    if (!draft?.pendingToken) return;
    const unchanged = guard();
    const request = ++paymentRequest.current;
    const valid = () => unchanged() && request === paymentRequest.current;
    setPaymentChecking(true);
    reconcilePledge(draft.pendingToken)
      .then((result) => {
        if (valid()) applyPayment(result);
      })
      .catch((e) => {
        if (valid())
          setError(
            apiErrorMessage(
              e,
              'Payment status is not confirmed. Editing and new checkout are blocked.',
            ),
          );
      })
      .finally(() => {
        if (valid()) setPaymentChecking(false);
      });
  }, [draft?.id, draft?.updatedAt, draft?.pendingToken, externalRevision, guard, applyPayment]);

  useEffect(() => {
    if (pending?.format !== 'POOLED' || !pending.channel_id || pending.plan.usage_cents.goal !== 0)
      return;
    const valid = guard();
    let active = true;
    setDefaultGoal(null);
    setPreviewError(true);
    getDefaultGoalPreview(pending.channel_id)
      .then((preview) => {
        if (active && valid()) {
          setDefaultGoal(preview.goal);
          setPreviewError(false);
        }
      })
      .catch(() => {
        /* The immutable plan is still valid; preview is explanatory only. */
      });
    return () => {
      active = false;
    };
  }, [pending, guard]);

  const fetchCatalog = useCallback(async () => {
    const [r, p, g, c] = await Promise.all([getRewards(), getPolls(), getGoals(), getChannels()]);
    return { r, p, g, c };
  }, []);
  const showCatalog = useCallback((fresh: Awaited<ReturnType<typeof fetchCatalog>>) => {
    setRewards((old) => mergeById(old, fresh.r));
    setPolls((old) =>
      mergeById(
        old,
        fresh.p.map((p) => ({
          ...p,
          options: mergeById(old.find((o) => o.id === p.id)?.options ?? [], p.options),
        })),
      ),
    );
    setGoals((old) => mergeById(old, fresh.g));
    setChannels(fresh.c.filter((c) => c.is_active));
    setLoading(false);
  }, []);
  const repair = useCallback((d: DraftPledge, fresh: Awaited<ReturnType<typeof fetchCatalog>>) => {
    const changes: string[] = [];
    const availableChannel = fresh.c.some((c) => c.id === d.channelId && c.is_active);
    if (d.channelId && !availableChannel)
      changes.push(
        'Channel is no longer available. Choose a Channel; shared selections and your amount are kept.',
      );
    const matches = (id: string | null | undefined) =>
      !id || (availableChannel && id === d.channelId);
    const selections: DraftSelection[] = [];
    for (const item of d.selections) {
      let next = { ...item };
      let reason = '';
      if (item.channel_id && !matches(item.channel_id)) reason = 'Channel item removed';
      else if (item.kind === 'REWARD') {
        const r = fresh.r.find((r) => r.id === item.target_id);
        if (!r || r.is_active === false || !matches(r.channel_id)) reason = 'No longer available';
        else {
          const stock =
            r.quantity_total === null
              ? Infinity
              : Math.max(0, r.quantity_total - r.quantity_claimed);
          const quantity = Math.min(item.quantity ?? 1, stock);
          if (quantity === 0) reason = 'Sold out';
          else {
            if (quantity !== (item.quantity ?? 1))
              changes.push(`${item.label ?? item.target_id}: quantity reduced to ${quantity}`);
            if (r.cost_cents !== item.unit_price_cents || r.type !== item.reward_type)
              changes.push(`${item.label ?? item.target_id}: current price/type applied`);
            next = {
              ...next,
              quantity,
              unit_price_cents: r.cost_cents,
              reward_type: r.type,
              amount_cents: r.cost_cents * quantity,
              label: r.title,
              channel_id: r.channel_id ?? null,
            };
            if (next.amount_cents < 100) reason = 'Below the $1 selection minimum';
          }
        }
      } else if (item.kind === 'GOAL') {
        const g = fresh.g.find((g) => g.id === item.target_id);
        if (!g || g.is_active === false || g.is_complete || !matches(g.channel_id))
          reason = 'Goal closed or deleted';
        else next = { ...next, label: g.title, channel_id: g.channel_id ?? null };
      } else {
        const p = fresh.p.find((p) => p.id === item.poll_id);
        if (
          !p ||
          p.is_active === false ||
          !matches(p.channel_id) ||
          (p.ends_at && new Date(p.ends_at).getTime() <= Date.now())
        )
          reason = 'Poll closed or deleted';
        else if (item.kind === 'POLL_VOTE') {
          const o = p.options.find((o) => o.id === item.target_id);
          if (!o || o.status === 'REJECTED') reason = 'Option rejected or deleted';
          else next = { ...next, label: o.label, channel_id: p.channel_id ?? null };
        } else if (!p.allow_custom_entries) reason = 'Write-ins closed';
        else next.channel_id = p.channel_id ?? null;
      }
      if (reason) changes.push(`${item.label ?? item.target_id}: ${reason}`);
      else selections.push(next);
    }
    return {
      next: { ...d, selections, channelId: availableChannel ? d.channelId : null },
      changes,
    };
  }, []);

  const loadEditable = useCallback(
    async (reviewing = false) => {
      if (current.current?.pendingToken || flight.current) return;
      const valid = guard();
      const d = current.current;
      const loadEpoch = epoch.current;
      setBusy(true);
      flight.current = true;
      if (reviewing) {
        setReviewReady(false);
        setError('');
      }
      try {
        const fresh = await fetchCatalog();
        const balance =
          reviewing && isSessionActive() ? (await getDonor()).balance_remaining : null;
        const previewChannel = d?.channelId;
        let preview: { goal: { id: string; title: string } | null } | null = null;
        if (reviewing && previewChannel) {
          try {
            preview = await getDefaultGoalPreview(previewChannel);
          } catch {
            /* explanatory, not a funding guarantee */
          }
        }
        if (!valid()) return;
        showCatalog(fresh);
        if (reviewing) {
          setWallet(balance);
          setDefaultGoal(preview?.goal ?? null);
          setPreviewError(!!previewChannel && !preview);
          setReviewReady(true);
        }
        if (d) {
          const { next, changes } = repair(d, fresh);
          if (changes.length) {
            setNotices((old) => [...old, ...changes]);
            setCorrectedPlan(null);
            // Background repairs cannot waive an outstanding server reconfirmation.
          }
          if (changes.length || (reviewing && d.lastStep !== 'review'))
            store({
              ...next,
              lastStep: reviewing ? 'review' : d.lastStep,
              updatedAt: Math.max(Date.now(), d.updatedAt + 1),
            });
        }
      } catch (e) {
        if (valid()) {
          setError(apiErrorMessage(e, 'Could not refresh the review. Try again before paying.'));
          setLoading(false);
        }
      } finally {
        if (mounted.current && epoch.current === loadEpoch) {
          flight.current = false;
          setBusy(false);
        }
      }
      // loadEpoch belongs to this invocation, not to a draft which repair just revised.
    },
    [guard, fetchCatalog, showCatalog, repair, store],
  );

  const refreshEditable = useCallback(
    () => loadEditable(current.current?.lastStep === 'review'),
    [loadEditable],
  );

  // No catalog fetch/repair may run while a token is unresolved, including TTL.
  useEffect(() => {
    if (draft?.pendingToken) return;
    void loadEditable(draft?.lastStep === 'review');
    const timer = setInterval(() => {
      if (!current.current?.pendingToken && !flight.current)
        void loadEditable(current.current?.lastStep === 'review');
    }, INCENTIVES_POLL_MS);
    return () => clearInterval(timer);
    // Local edits do not restart the catalog request; cross-tab revisions do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.pendingToken, externalRevision, loadEditable]);

  const selectedChannelId = draft?.channelId ?? channelId;
  const rewards = useMemo(
    () => allRewards.filter((r) => !r.channel_id || r.channel_id === selectedChannelId),
    [allRewards, selectedChannelId],
  );
  const polls = useMemo(
    () => allPolls.filter((p) => !p.channel_id || p.channel_id === selectedChannelId),
    [allPolls, selectedChannelId],
  );
  const goals = useMemo(
    () => allGoals.filter((g) => !g.channel_id || g.channel_id === selectedChannelId),
    [allGoals, selectedChannelId],
  );
  const selections = draft?.selections ?? [];
  const plan = useMemo(() => {
    if (pending?.format === 'POOLED') return pending.plan;
    if (correctedPlan) return correctedPlan;
    if (!draft) return null;
    try {
      return planPledge({
        pledge_amount_cents: draft.amountCents,
        available_wallet_cents: wallet,
        selections: draft.selections.map((i, index): PledgeSelection => ({
          ...i,
          insertion_order: i.insertion_order ?? index,
        })),
      });
    } catch {
      return null;
    }
  }, [pending, correctedPlan, draft, wallet]);

  const selectChannel = useCallback(
    (id: string, path = '/donate', eventSlug: string | null = null) => {
      if (current.current?.pendingToken || flight.current) return;
      const next = { id, path, eventSlug };
      if (
        id !== channelRef.current &&
        current.current?.selections.some((i) => i.channel_id && i.channel_id !== id)
      ) {
        setPendingChannel(next);
        return;
      }
      channelRef.current = id;
      setChannelId(id);
      routeRef.current = { path, eventSlug };
      if (current.current && (id !== current.current.channelId || path !== current.current.path))
        edit({ channelId: id, path, eventSlug });
    },
    [edit],
  );
  const confirmChannelSwitch = useCallback(() => {
    if (!pendingChannel || current.current?.pendingToken || flight.current) return;
    const { id, path, eventSlug } = pendingChannel;
    edit({
      channelId: id,
      path,
      eventSlug,
      selections:
        current.current?.selections.filter((i) => !i.channel_id || i.channel_id === id) ?? [],
    });
    channelRef.current = id;
    setChannelId(id);
    routeRef.current = { path, eventSlug };
    setPendingChannel(null);
  }, [pendingChannel, edit]);
  const confirmAmount = useCallback(
    (amount: number, step: DraftStep) => {
      if (
        !Number.isSafeInteger(amount) ||
        amount < 100 ||
        amount > 2147483647 ||
        current.current?.pendingToken ||
        flight.current ||
        !channelRef.current
      )
        return;
      if (current.current) edit({ amountCents: amount, lastStep: step });
      else {
        setSuccess(null);
        store({
          id: crypto.randomUUID(),
          updatedAt: Date.now(),
          amountCents: amount,
          selections: [],
          channelId: channelRef.current,
          ...routeRef.current,
          comment: '',
          displayName: localStorage.getItem(NAME_KEY) ?? '',
          lastStep: step,
          tab: 'rewards',
          pendingToken: null,
        });
      }
      if (step === 'review') void loadEditable(true);
    },
    [edit, store, loadEditable],
  );
  const addSelection = useCallback(
    (item: DraftSelection) => {
      const d = current.current;
      if (!d || d.pendingToken || flight.current) return;
      const reward = allRewards.find((r) => r.id === item.target_id);
      const scope =
        item.kind === 'REWARD'
          ? reward?.channel_id
          : item.kind === 'GOAL'
            ? allGoals.find((g) => g.id === item.target_id)?.channel_id
            : allPolls.find((p) => p.id === item.poll_id)?.channel_id;
      if (scope && scope !== d.channelId) return;
      const old = d.selections.find(
        (i) => i.kind === item.kind && i.target_id === item.target_id && i.poll_id === item.poll_id,
      );
      const next = {
        ...item,
        channel_id: scope ?? null,
        insertion_order:
          old?.insertion_order ??
          Math.max(-1, ...d.selections.map((i) => i.insertion_order ?? 0)) + 1,
        ...(item.kind === 'REWARD' && reward
          ? {
              unit_price_cents: reward.cost_cents,
              reward_type: reward.type,
              quantity: item.quantity ?? old?.quantity ?? 1,
              amount_cents: reward.cost_cents * (item.quantity ?? old?.quantity ?? 1),
            }
          : {}),
      };
      edit({
        selections: old ? d.selections.map((i) => (i === old ? next : i)) : [...d.selections, next],
      });
    },
    [allRewards, allGoals, allPolls, edit],
  );
  const removeSelection = useCallback(
    (kind: DraftSelection['kind'], id: string) =>
      edit({
        selections:
          current.current?.selections.filter((i) => i.kind !== kind || i.target_id !== id) ?? [],
      }),
    [edit],
  );
  const changeQuantity = useCallback(
    (id: string, delta: number) => {
      const item = current.current?.selections.find(
        (i) => i.kind === 'REWARD' && i.target_id === id,
      );
      const reward = allRewards.find((r) => r.id === id);
      if (!item || !reward) return;
      const quantity = (item.quantity ?? 1) + delta;
      if (quantity === 0) {
        removeSelection('REWARD', id);
        return;
      }
      if (
        reward.quantity_total !== null &&
        quantity > reward.quantity_total - reward.quantity_claimed
      )
        return;
      addSelection({ ...item, quantity });
    },
    [allRewards, removeSelection, addSelection],
  );

  const prefillFromLink = useCallback(
    (params: URLSearchParams): string | null => {
      const d = current.current;
      if (d?.pendingToken || flight.current) return null;
      let item: DraftSelection | null = null;
      const r = allRewards.find((r) => r.id === params.get('reward'));
      const p = allPolls.find((p) => p.id === params.get('poll'));
      const g = allGoals.find((g) => g.id === params.get('goal'));
      if (params.has('reward')) {
        if (
          !r ||
          r.is_active === false ||
          (r.quantity_total !== null && r.quantity_claimed >= r.quantity_total)
        )
          return 'That reward is no longer available.';
        item = {
          kind: 'REWARD',
          target_id: r.id,
          amount_cents: r.cost_cents,
          label: r.title,
          channel_id: r.channel_id,
        };
      } else if (params.has('poll') && params.has('option')) {
        const o = p?.options.find((o) => o.id === params.get('option') && o.status !== 'REJECTED');
        if (
          !p ||
          !o ||
          p.is_active === false ||
          (p.ends_at && new Date(p.ends_at).getTime() <= Date.now())
        )
          return 'That poll option is no longer available.';
        item = {
          kind: 'POLL_VOTE',
          target_id: o.id,
          poll_id: p.id,
          amount_cents: Math.round(Number(params.get('amount') ?? DEFAULT_VOTE_AMOUNT) * 100),
          label: o.label,
          channel_id: p.channel_id,
        };
      } else if (params.has('goal')) {
        if (!g || g.is_active === false || g.is_complete)
          return 'That fund goal is no longer available.';
        item = {
          kind: 'GOAL',
          target_id: g.id,
          amount_cents: Math.round(Number(params.get('amount') ?? DEFAULT_GOAL_AMOUNT) * 100),
          label: g.title,
          channel_id: g.channel_id,
        };
      }
      if (!item) return null;
      if (!Number.isSafeInteger(item.amount_cents) || item.amount_cents < 100)
        return 'Minimum selection amount is $1.00.';
      if (!d) {
        if (item.channel_id && item.channel_id !== channelRef.current)
          selectChannel(item.channel_id);
        return null;
      }
      const key = `${item.kind}:${item.target_id}`;
      if (consumedLinks.current.has(key)) return null;
      if (item.channel_id && item.channel_id !== d.channelId) {
        selectChannel(item.channel_id);
        return 'Confirm the Channel switch, then apply this link.';
      }
      consumedLinks.current.add(key);
      addSelection(item);
      return null;
    },
    [allRewards, allPolls, allGoals, selectChannel, addSelection],
  );

  const checkout = useCallback(async () => {
    const d = current.current;
    if (
      !d ||
      d.pendingToken ||
      flight.current ||
      !d.channelId ||
      !plan ||
      !reviewReady ||
      corrected ||
      Object.values(plan.overage_cents).some((v) => v > 0)
    )
      return;
    if (d.comment.length > 500 || d.displayName.length > 60) {
      setError('Message maximum 500 characters; Display name maximum 60 characters.');
      return;
    }
    const valid = guard();
    const operationEpoch = epoch.current;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await createPledge({
        pledge_amount_cents: d.amountCents,
        draft_id: d.id,
        plan,
        channel_id: d.channelId,
        email: email.trim() || undefined,
        comment: d.comment.trim() || undefined,
        display_name: d.displayName.trim() || undefined,
        items: d.selections.map((i) => ({
          kind: i.kind,
          target_id: i.target_id,
          amount_cents: i.amount_cents,
          quantity: i.quantity,
          insertion_order: i.insertion_order,
          poll_id: i.poll_id,
          data: i.data,
        })),
      });
      if (!valid()) return;
      localStorage.setItem(EMAIL_KEY, email.trim());
      localStorage.setItem(NAME_KEY, d.displayName.trim());
      store({
        ...d,
        pendingToken: result.pledge_token,
        lastStep: 'review',
        updatedAt: Math.max(Date.now(), d.updatedAt + 1),
      });
      applyPayment(result);
      if (result.checkout_error) setError(result.checkout_error);
      // Persist the token BEFORE leaving this page. Never clear on checkout.
      if (result.payment_state === 'OPEN' && result.can_continue && result.donate_url)
        window.location.assign(result.donate_url);
    } catch (e) {
      if (!valid()) return;
      const data = (e as { response?: { status?: number; data?: { plan?: PledgePlan } } }).response;
      if (data?.status === 409 && data.data?.plan) {
        const nextPlan = data.data.plan;
        const repaired = nextPlan.selections.map((i) => ({
          ...i,
          poll_id: i.poll_id ?? undefined,
          data: i.data as DraftSelection['data'],
          label:
            d.selections.find((o) => o.kind === i.kind && o.target_id === i.target_id)?.label ??
            i.target_id,
          channel_id:
            d.selections.find((o) => o.kind === i.kind && o.target_id === i.target_id)
              ?.channel_id ?? null,
        }));
        const changes: string[] = [];
        for (const old of d.selections) {
          const next = nextPlan.selections.find(
            (i) =>
              i.insertion_order === old.insertion_order &&
              i.kind === old.kind &&
              i.target_id === old.target_id,
          );
          const label = old.label ?? old.target_id;
          if (!next) changes.push(`${label}: removed in corrected server review`);
          else {
            if (next.quantity !== (old.quantity ?? 1))
              changes.push(`${label}: server quantity changed to ${next.quantity}`);
            if (
              old.kind === 'REWARD' &&
              (next.unit_price_cents !== old.unit_price_cents ||
                next.reward_type !== old.reward_type)
            )
              changes.push(`${label}: server current price/type applied`);
            if (old.kind !== 'REWARD' && next.amount_cents !== old.amount_cents)
              changes.push(`${label}: server amount changed`);
          }
        }
        setNotices((old) => [...old, ...changes]);
        store({ ...d, selections: repaired, updatedAt: Math.max(Date.now(), d.updatedAt + 1) });
        setCorrectedPlan(nextPlan);
        setCorrected(true);
      }
      setError(apiErrorMessage(e, 'Could not confirm your pledge. Retry with this same draft.'));
    } finally {
      if (mounted.current && epoch.current === operationEpoch) {
        flight.current = false;
        setBusy(false);
      }
    }
  }, [plan, reviewReady, corrected, email, guard, store, applyPayment]);

  const value: DraftContextValue = {
    draft,
    selections,
    rewards,
    polls,
    goals,
    channels,
    loading,
    selectedChannelId,
    pendingChannelId: pendingChannel?.id ?? null,
    selectChannel,
    confirmChannelSwitch,
    cancelChannelSwitch: () => setPendingChannel(null),
    confirmAmount,
    setStep: (step) => edit({ lastStep: step }),
    setTab: (tab) => edit({ tab }),
    addSelection,
    removeSelection,
    incrementRewardQuantity: (id) => changeQuantity(id, 1),
    decrementRewardQuantity: (id) => changeQuantity(id, -1),
    email,
    setEmail,
    setComment: (comment) => edit({ comment }),
    setDisplayName: (displayName) => edit({ displayName }),
    plan,
    notices,
    error,
    busy,
    reviewReady,
    pending,
    paymentChecking,
    success,
    defaultGoal,
    previewError,
    corrected,
    confirmCorrected: () => {
      setCorrected(false);
      setError('');
    },
    review: () => loadEditable(true),
    refreshEditable,
    checkout,
    checkPayment,
    editPending,
    continuePayment,
    prefillFromLink,
    paymentObserver,
  };
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}
