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
import { getRewards } from '../api/rewards';
import { getPolls } from '../api/polls';
import { getGoals } from '../api/goals';
import { getChannels } from '../api/channels';
import { createPledge } from '../api/pledge';
import { track, trackAsync } from '../lib/tracing';
import {
  DEFAULT_VOTE_AMOUNT,
  DEFAULT_GOAL_AMOUNT,
  MIN_SPEND_CENTS,
  MIN_SPEND_DOLLARS,
} from '../config';
import {
  apiErrorMessage,
  type CartItem,
  type Reward,
  type Poll,
  type PollOption,
  type Goal,
  type Channel,
  type PledgeResult,
} from '../types';
import { INCENTIVES_POLL_MS } from '../config';

const CART_STORAGE_KEY = 'donation_cart_v1';
const EMAIL_STORAGE_KEY = 'last_donor_email';
const DISPLAY_NAME_STORAGE_KEY = 'last_donor_display_name';

/**
 * Merge freshly-fetched records into the current list while preserving the
 * current on-screen order. Records present in both are updated in place;
 * brand-new records are appended. Records that are no longer in the fresh
 * payload are dropped UNLESS their id is in `protectedIds` — those are kept
 * (with their last-known data) so a donor's in-progress cart selection is
 * never yanked out from under them by a background refresh. Returns the set of
 * ids that were kept only because they're protected (i.e. no longer present
 * in the fresh payload) so callers can surface them as unavailable.
 */
function mergeById<T extends { id: string }>(
  current: T[],
  fresh: T[],
  protectedIds: ReadonlySet<string>,
): { merged: T[]; staleIds: Set<string> } {
  const freshById = new Map(fresh.map((f) => [f.id, f]));
  const currentIds = new Set(current.map((c) => c.id));
  const staleIds = new Set<string>();
  const merged = current
    .filter((c) => {
      if (freshById.has(c.id)) return true;
      if (protectedIds.has(c.id)) {
        staleIds.add(c.id);
        return true;
      }
      return false;
    })
    .map((c) => freshById.get(c.id) ?? c);
  for (const f of fresh) {
    if (!currentIds.has(f.id)) merged.push(f);
  }
  return { merged, staleIds };
}

/**
 * Poll-specific merge: the server orders options by votes_cents desc, so a
 * naive replace would reorder options as votes come in and make the page jump
 * under the donor. Preserve the current option order (updating counts in
 * place) while still refreshing the poll's own fields. Options that are in the
 * cart are protected from being dropped when they leave the fresh payload.
 * Returns the sets of poll ids and option ids that were kept only because
 * they're protected (no longer present in the fresh payload).
 */
function mergePolls(
  current: Poll[],
  fresh: Poll[],
  protectedPollIds: ReadonlySet<string>,
  protectedOptionIds: ReadonlySet<string>,
): { merged: Poll[]; stalePollIds: Set<string>; staleOptionIds: Set<string> } {
  const freshById = new Map(fresh.map((f) => [f.id, f]));
  const currentIds = new Set(current.map((c) => c.id));
  const stalePollIds = new Set<string>();
  const staleOptionIds = new Set<string>();
  const merged = current
    .filter((c) => {
      if (freshById.has(c.id)) return true;
      if (protectedPollIds.has(c.id)) {
        stalePollIds.add(c.id);
        return true;
      }
      return false;
    })
    .map((c) => {
      const f = freshById.get(c.id);
      if (!f) return c;
      const { merged: options, staleIds } = mergeById<PollOption>(
        c.options,
        f.options,
        protectedOptionIds,
      );
      staleIds.forEach((id) => staleOptionIds.add(id));
      return { ...f, options };
    });
  for (const f of fresh) {
    if (!currentIds.has(f.id)) merged.push(f);
  }
  return { merged, stalePollIds, staleOptionIds };
}

export type IncentiveCategory = 'rewards' | 'polls' | 'goals';

export interface CartIssue {
  item: CartItem;
  reason: string;
}

interface StoredCartState {
  cart: CartItem[];
  topUp: string;
  comment: string;
  channelId: string | null;
}

function loadStoredCart(): StoredCartState {
  try {
    const raw = sessionStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return { cart: [], topUp: '', comment: '', channelId: null };
    const parsed = JSON.parse(raw) as Partial<StoredCartState>;
    return {
      cart: Array.isArray(parsed.cart) ? parsed.cart : [],
      topUp: typeof parsed.topUp === 'string' ? parsed.topUp : '',
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
      channelId: typeof parsed.channelId === 'string' ? parsed.channelId : null,
    };
  } catch {
    return { cart: [], topUp: '', comment: '', channelId: null };
  }
}

interface CartContextValue {
  // Live incentive data — fetched once here so every consumer (the /donate
  // stepper, the standalone browse pages, and the cart drawer) shares a
  // single fetch instead of each re-fetching independently. Already filtered
  // to the selected channel (shared incentives + the selected channel's own).
  rewards: Reward[];
  polls: Poll[];
  goals: Goal[];
  loading: boolean;

  // Channels — every donation is routed to exactly one channel (required, for
  // overlay routing). Incentives with a null channel_id are shared and appear
  // regardless of which channel is selected; incentives tied to a specific
  // channel only appear (and can only be added to the cart) when that channel
  // is selected. A cart therefore can never mix incentives from two
  // different channels.
  channels: Channel[];
  selectedChannelId: string | null;
  // Refetches only the channel list on demand (e.g. when the donate flow
  // mounts), so a newly opened channel shows up immediately instead of
  // waiting for the next background poll (#46). Cheap and safe to call
  // repeatedly — it's a plain replace, same as the background poll does.
  refreshChannels: () => void;
  // Attempts to select a channel. If the current cart holds items tied to a
  // *different* specific channel, the switch is held pending confirmation
  // (see pendingChannelId) instead of applied immediately.
  selectChannel: (channelId: string) => void;
  pendingChannelId: string | null;
  confirmChannelSwitch: () => void;
  cancelChannelSwitch: () => void;

  // Cart contents
  cart: CartItem[];
  addToCart: (item: CartItem) => void;
  removeFromCart: (kind: CartItem['kind'], targetId: string) => void;
  // REWARD-only quantity stepper: increments/decrements the quantity of an
  // already-added reward, recomputing amount_cents as cost_cents * quantity
  // from the live reward data. Decrementing to 0 removes the item. A no-op
  // if the reward isn't in the cart, or (increment) if it would exceed the
  // reward's remaining stock.
  incrementRewardQuantity: (targetId: string) => void;
  decrementRewardQuantity: (targetId: string) => void;
  cartTotal: number;

  // Additional donation on top of incentives, plus donor-facing fields.
  // These live here (rather than only in the checkout step) because the
  // cart drawer can submit a pledge directly from anywhere on the site.
  topUp: string;
  setTopUp: (value: string) => void;
  topUpCents: number;
  email: string;
  setEmail: (value: string) => void;
  comment: string;
  setComment: (value: string) => void;
  displayName: string;
  setDisplayName: (value: string) => void;
  totalCents: number;

  // Tracks which incentive categories the donor has actually been shown
  // (stepper step or standalone page — see markVisited callers), so the
  // drawer can nudge about categories skipped via direct checkout.
  markVisited: (category: IncentiveCategory) => void;
  unvisitedAvailableCategories: IncentiveCategory[];
  hasVisited: (category: IncentiveCategory) => boolean;

  // Global cart drawer open state
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;

  // Checkout
  submitting: boolean;
  checkoutError: string;
  setCheckoutError: (value: string) => void;
  checkout: () => Promise<PledgeResult | null>;

  // Client-side pre-submit revalidation: re-fetches live incentive state and
  // flags cart items that are no longer available (sold out, poll ended,
  // goal completed). The server independently revalidates everything again
  // at pledge creation and fulfillment — this is just so the donor gets a
  // chance to fix their cart instead of the whole pledge being rejected on
  // one stale item.
  revalidateCart: () => Promise<CartIssue[]>;

  // Ids of incentives that are no longer present in the live payload but are
  // kept visible because they're in the cart. Consumers render an
  // "unavailable" indicator on these so the donor knows they've closed.
  staleRewardIds: ReadonlySet<string>;
  stalePollIds: ReadonlySet<string>;
  staleOptionIds: ReadonlySet<string>;
  staleGoalIds: ReadonlySet<string>;

  // Prefills the cart from a shared permalink (e.g. /rewards?reward=<id>).
  // Resolves the linked incentive against the loaded data, auto-selects its
  // channel, adds it to the cart, and opens the drawer. Returns a warning
  // string when the target is missing/inactive/sold out so the caller can
  // surface it instead of silently doing nothing. Safe to call repeatedly —
  // it only acts once per distinct target.
  prefillFromLink: (params: URLSearchParams) => string | null;
}

const CartContext = createContext<CartContextValue | null>(null);

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [allRewards, setAllRewards] = useState<Reward[]>([]);
  const [allPolls, setAllPolls] = useState<Poll[]>([]);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  const initialStored = useRef(loadStoredCart());
  const [cart, setCart] = useState<CartItem[]>(initialStored.current.cart);
  const [topUp, setTopUp] = useState(initialStored.current.topUp);
  const [comment, setComment] = useState(initialStored.current.comment);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    initialStored.current.channelId,
  );
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_STORAGE_KEY) || '');
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) || '',
  );

  const [visited, setVisited] = useState<Set<IncentiveCategory>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');

  // Ids of incentives that are no longer present in the live payload but are
  // kept visible because they're in the cart. Consumers render an
  // "unavailable" indicator on these so the donor knows they've closed.
  const [staleRewardIds, setStaleRewardIds] = useState<Set<string>>(new Set());
  const [stalePollIds, setStalePollIds] = useState<Set<string>>(new Set());
  const [staleOptionIds, setStaleOptionIds] = useState<Set<string>>(new Set());
  const [staleGoalIds, setStaleGoalIds] = useState<Set<string>>(new Set());

  // Mirrors of the incentive lists so the polling interval can read the
  // latest values without being recreated on every state change.
  const prevRewardsRef = useRef(allRewards);
  const prevPollsRef = useRef(allPolls);
  const prevGoalsRef = useRef(allGoals);
  prevRewardsRef.current = allRewards;
  prevPollsRef.current = allPolls;
  prevGoalsRef.current = allGoals;

  // Permalinks are applied exactly once per distinct target so a re-render
  // (or a re-navigation to the same link) doesn't re-add the item.
  const consumedPrefill = useRef<Set<string>>(new Set());

  const fetchAll = useCallback(async () => {
    const [r, p, g, s] = await Promise.all([getRewards(), getPolls(), getGoals(), getChannels()]);
    setAllRewards(r);
    setAllPolls(p);
    setAllGoals(g);
    setChannels(s);
    return { r, p, g, s };
  }, []);

  const refreshChannels = useCallback(() => {
    getChannels()
      .then(setChannels)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  // Background refresh so incentive state (sold-out counts, poll tallies, goal
  // progress, newly opened channels) updates for clients without a reload.
  // The merge helpers above preserve the current on-screen order and never
  // drop items that are in the cart, so a donor's in-progress selection is
  // never disturbed by a refresh. The cart is read through a ref so the
  // interval isn't torn down and recreated on every cart change.
  const cartRef = useRef(cart);
  cartRef.current = cart;
  useEffect(() => {
    const timer = setInterval(() => {
      fetchAll().then(({ r, p, g, s }) => {
        const currentCart = cartRef.current;
        const protectedRewardIds = new Set(
          currentCart.filter((i) => i.kind === 'REWARD').map((i) => i.target_id),
        );
        const protectedGoalIds = new Set(
          currentCart.filter((i) => i.kind === 'GOAL').map((i) => i.target_id),
        );
        const protectedPollIds = new Set(
          currentCart
            .filter((i) => i.kind === 'POLL_VOTE' || i.kind === 'POLL_CUSTOM')
            .map((i) => i.poll_id!),
        );
        const protectedOptionIds = new Set(
          currentCart.filter((i) => i.kind === 'POLL_VOTE').map((i) => i.target_id),
        );
        const rewards = mergeById(prevRewardsRef.current, r, protectedRewardIds);
        const polls = mergePolls(prevPollsRef.current, p, protectedPollIds, protectedOptionIds);
        const goals = mergeById(prevGoalsRef.current, g, protectedGoalIds);
        setAllRewards(rewards.merged);
        setAllPolls(polls.merged);
        setAllGoals(goals.merged);
        setStaleRewardIds(rewards.staleIds);
        setStalePollIds(polls.stalePollIds);
        setStaleOptionIds(polls.staleOptionIds);
        setStaleGoalIds(goals.staleIds);
        setChannels(s);
      });
    }, INCENTIVES_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchAll]);

  // Session-scoped persistence. Incentive lifetimes are hours at most, so a
  // cart that survives a browser restart is more likely to reference
  // stale/closed items than to be a useful convenience — sessionStorage
  // (cleared when the tab closes) is the safer default.
  useEffect(() => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ cart, topUp, comment, channelId: selectedChannelId }),
    );
  }, [cart, topUp, comment, selectedChannelId]);

  // Visible incentive lists — shared (channel_id null) + whichever channel is
  // currently selected. Until a channel is selected, only shared incentives
  // are shown; the /donate channel picker requires a selection before the
  // donor can browse channel-specific incentives at all.
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

  // Resolves the channel_id of the incentive backing a cart item (null for
  // shared incentives or items we can no longer find — the latter get
  // surfaced separately via revalidateCart).
  const itemChannelId = useCallback(
    (item: CartItem): string | null => {
      if (item.kind === 'REWARD') {
        return allRewards.find((r) => r.id === item.target_id)?.channel_id ?? null;
      }
      if (item.kind === 'POLL_VOTE' || item.kind === 'POLL_CUSTOM') {
        return allPolls.find((p) => p.id === item.poll_id)?.channel_id ?? null;
      }
      if (item.kind === 'GOAL') {
        return allGoals.find((g) => g.id === item.target_id)?.channel_id ?? null;
      }
      return null;
    },
    [allRewards, allPolls, allGoals],
  );

  const addToCart = useCallback((item: CartItem) => {
    track('cart_add', {
      'item.kind': item.kind,
      'item.target_id': item.target_id,
      'item.amount_cents': item.amount_cents,
    });
    setCart((prev) => {
      const idx = prev.findIndex(
        (i) => i.kind === item.kind && i.target_id === item.target_id && i.poll_id === item.poll_id,
      );
      if (idx >= 0) {
        const updated = [...prev];
        // label must also sync on re-add: a POLL_CUSTOM write-in's label can
        // change when the donor edits it (#44) — previously only
        // amount_cents/data were carried over, so an edited write-in silently
        // kept its old label in the cart despite the modal showing the edit.
        updated[idx] = {
          ...updated[idx]!,
          amount_cents: item.amount_cents,
          label: item.label,
          data: item.data,
        };
        return updated;
      }
      return [...prev, item];
    });
  }, []);

  const removeFromCart = useCallback((kind: CartItem['kind'], targetId: string) => {
    track('cart_remove', { 'item.kind': kind, 'item.target_id': targetId });
    setCart((prev) => prev.filter((i) => !(i.kind === kind && i.target_id === targetId)));
  }, []);

  const incrementRewardQuantity = useCallback(
    (targetId: string) => {
      const reward = allRewards.find((r) => r.id === targetId);
      if (!reward) return;
      setCart((prev) => {
        const idx = prev.findIndex((i) => i.kind === 'REWARD' && i.target_id === targetId);
        if (idx < 0) return prev;
        const current = prev[idx]!;
        const nextQuantity = (current.quantity ?? 1) + 1;
        const available =
          reward.quantity_total === null
            ? Infinity
            : reward.quantity_total - reward.quantity_claimed;
        if (nextQuantity > available) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...current,
          quantity: nextQuantity,
          amount_cents: reward.cost_cents * nextQuantity,
        };
        return updated;
      });
    },
    [allRewards],
  );

  const decrementRewardQuantity = useCallback(
    (targetId: string) => {
      setCart((prev) => {
        const idx = prev.findIndex((i) => i.kind === 'REWARD' && i.target_id === targetId);
        if (idx < 0) return prev;
        const current = prev[idx]!;
        const nextQuantity = (current.quantity ?? 1) - 1;
        if (nextQuantity <= 0) {
          return prev.filter((_, i) => i !== idx);
        }
        const reward = allRewards.find((r) => r.id === targetId);
        const unitCost = reward?.cost_cents ?? current.amount_cents / (current.quantity ?? 1);
        const updated = [...prev];
        updated[idx] = {
          ...current,
          quantity: nextQuantity,
          amount_cents: unitCost * nextQuantity,
        };
        return updated;
      });
    },
    [allRewards],
  );

  const clearCart = useCallback(() => {
    setCart([]);
    setTopUp('');
    setComment('');
    sessionStorage.removeItem(CART_STORAGE_KEY);
  }, []);

  // Incentives cannot be mixed across channels in a single transaction (each
  // donation routes to exactly one channel overlay). Selecting a different
  // channel while the cart holds items tied to a *different* specific channel
  // is held pending confirmation rather than applied immediately; shared
  // items are always kept regardless of which channel ends up selected.
  const selectChannel = useCallback(
    (channelId: string) => {
      if (channelId === selectedChannelId) return;
      const hasConflict = cart.some((item) => {
        const itemChannelValue = itemChannelId(item);
        return itemChannelValue && itemChannelValue !== channelId;
      });
      if (hasConflict) {
        setPendingChannelId(channelId);
      } else {
        setSelectedChannelId(channelId);
      }
    },
    [cart, itemChannelId, selectedChannelId],
  );

  const confirmChannelSwitch = useCallback(() => {
    if (!pendingChannelId) return;
    const nextChannelId = pendingChannelId;
    setCart((prev) => {
      const keep = prev.filter((item) => {
        const itemChannelValue = itemChannelId(item);
        return !itemChannelValue || itemChannelValue === nextChannelId;
      });
      return keep;
    });
    setSelectedChannelId(nextChannelId);
    setPendingChannelId(null);
  }, [pendingChannelId, itemChannelId]);

  const cancelChannelSwitch = useCallback(() => {
    setPendingChannelId(null);
  }, [pendingChannelId, itemChannelId]);

  const cartTotal = cart.reduce((sum, item) => sum + item.amount_cents, 0);
  const topUpCentsRaw = Math.round(parseFloat(topUp || '0') * 100);
  const topUpCents = isNaN(topUpCentsRaw) ? 0 : topUpCentsRaw;
  const totalCents = cartTotal + topUpCents;

  const markVisited = useCallback((category: IncentiveCategory) => {
    setVisited((prev) => {
      if (prev.has(category)) return prev;
      const next = new Set(prev);
      next.add(category);
      return next;
    });
  }, []);

  const unvisitedAvailableCategories = useMemo(() => {
    const result: IncentiveCategory[] = [];
    if (!visited.has('rewards') && rewards.length > 0) result.push('rewards');
    if (!visited.has('polls') && polls.length > 0) result.push('polls');
    if (!visited.has('goals') && goals.length > 0) result.push('goals');
    return result;
  }, [visited, rewards, polls, goals]);

  const hasVisited = useCallback((category: IncentiveCategory) => visited.has(category), [visited]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  const revalidateCart = useCallback(async (): Promise<CartIssue[]> => {
    const { r: freshRewards, p: freshPolls, g: freshGoals } = await fetchAll();
    const issues: CartIssue[] = [];
    for (const item of cart) {
      if (item.kind === 'REWARD') {
        const reward = freshRewards.find((r) => r.id === item.target_id);
        if (!reward || reward.is_active === false) {
          issues.push({ item, reason: 'No longer available' });
          continue;
        }
        const soldOut =
          reward.quantity_total !== null &&
          reward.quantity_total - reward.quantity_claimed < (item.quantity ?? 1);
        if (soldOut) issues.push({ item, reason: 'Sold out' });
      } else if (item.kind === 'POLL_VOTE' || item.kind === 'POLL_CUSTOM') {
        const poll = freshPolls.find((p) => p.id === item.poll_id);
        if (!poll || poll.is_active === false) {
          issues.push({ item, reason: 'Poll no longer active' });
          continue;
        }
        if (poll.ends_at && new Date(poll.ends_at) < new Date()) {
          issues.push({ item, reason: 'Poll has ended' });
        }
      } else if (item.kind === 'GOAL') {
        const goal = freshGoals.find((g) => g.id === item.target_id);
        if (!goal || goal.is_active === false) {
          issues.push({ item, reason: 'No longer active' });
          continue;
        }
        if (goal.is_complete) issues.push({ item, reason: 'Goal already complete' });
      }
    }
    return issues;
  }, [cart, fetchAll]);

  // Resolves a shared permalink into a cart item. Returns null when the
  // target is missing/inactive/sold out (the caller surfaces a warning), or
  // when the amount is below the minimum spend.
  const prefillFromLink = useCallback(
    (params: URLSearchParams): string | null => {
      const rewardId = params.get('reward');
      const pollId = params.get('poll');
      const optionId = params.get('option');
      const goalId = params.get('goal');
      const amountParam = params.get('amount');

      let item: CartItem | null = null;
      let channelId: string | null = null;

      if (rewardId) {
        const reward = allRewards.find((r) => r.id === rewardId);
        if (!reward || reward.is_active === false) return 'That reward is no longer available.';
        const soldOut =
          reward.quantity_total !== null && reward.quantity_claimed >= reward.quantity_total;
        if (soldOut) return 'That reward is sold out.';
        item = {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: reward.cost_cents,
          label: reward.title,
        };
        channelId = reward.channel_id ?? null;
      } else if (pollId && optionId) {
        const poll = allPolls.find((p) => p.id === pollId);
        if (!poll || poll.is_active === false) return 'That poll is no longer active.';
        if (poll.ends_at && new Date(poll.ends_at) < new Date()) return 'That poll has ended.';
        const option = poll.options.find((o) => o.id === optionId);
        if (!option) return 'That poll option is no longer available.';
        const cents = Math.round(parseFloat(amountParam ?? DEFAULT_VOTE_AMOUNT) * 100);
        if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
          return `Minimum vote amount is $${MIN_SPEND_DOLLARS.toFixed(2)}.`;
        }
        item = {
          kind: 'POLL_VOTE',
          target_id: option.id,
          poll_id: poll.id,
          amount_cents: cents,
          label: option.label,
        };
        channelId = poll.channel_id ?? null;
      } else if (goalId) {
        const goal = allGoals.find((g) => g.id === goalId);
        if (!goal || goal.is_active === false) return 'That fund goal is no longer active.';
        if (goal.is_complete) return 'That fund goal is already complete.';
        const cents = Math.round(parseFloat(amountParam ?? DEFAULT_GOAL_AMOUNT) * 100);
        if (isNaN(cents) || cents < MIN_SPEND_CENTS) {
          return `Minimum contribution is $${MIN_SPEND_DOLLARS.toFixed(2)}.`;
        }
        item = {
          kind: 'GOAL',
          target_id: goal.id,
          amount_cents: cents,
          label: goal.title,
        };
        channelId = goal.channel_id ?? null;
      } else {
        return null;
      }

      const key = `${item.kind}:${item.target_id}`;
      if (consumedPrefill.current.has(key)) return null;
      consumedPrefill.current.add(key);

      // Auto-select the incentive's channel. Channel-specific items can't mix
      // with another channel's, so if the donor already has a conflicting cart
      // the switch is held pending confirmation (the existing modal) rather
      // than silently dropping their items.
      if (channelId) selectChannel(channelId);

      addToCart(item);
      openDrawer();
      return null;
    },
    [allRewards, allPolls, allGoals, selectChannel, addToCart, openDrawer],
  );

  const checkout = useCallback(async (): Promise<PledgeResult | null> => {
    setCheckoutError('');
    if (!email.trim()) {
      track('checkout_error', { 'error.reason': 'missing_email' });
      setCheckoutError('Please enter your email address');
      return null;
    }
    if (!selectedChannelId) {
      track('checkout_error', { 'error.reason': 'no_event_selected' });
      setCheckoutError('Select a channel before checking out');
      return null;
    }
    if (cart.length === 0 && topUpCents <= 0) {
      track('checkout_error', { 'error.reason': 'empty_cart' });
      setCheckoutError('Add an incentive or an additional donation to continue');
      return null;
    }
    track('checkout_start', { total_cents: totalCents, item_count: cart.length });
    setSubmitting(true);
    try {
      const result = await trackAsync(
        'checkout_create_pledge',
        () =>
          createPledge({
            email: email.trim(),
            comment: comment.trim() || undefined,
            display_name: displayName.trim() || undefined,
            top_up_cents: topUpCents > 0 ? topUpCents : undefined,
            channel_id: selectedChannelId,
            items: cart.map((item) => ({
              kind: item.kind,
              target_id: item.target_id,
              amount_cents: item.amount_cents,
              poll_id: item.poll_id,
              data: item.data,
              quantity: item.quantity,
            })),
          }),
        { 'pledge.total_cents': totalCents },
      );
      localStorage.setItem(EMAIL_STORAGE_KEY, email.trim());
      if (displayName.trim()) {
        localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName.trim());
      }
      // Clear now — the server-side PendingPledge is the source of truth
      // from here on. Re-submitting the same client cart after this point
      // (e.g. the donor hits "back" from Stripe) would create a duplicate
      // pledge; clearing avoids that. If Stripe is abandoned, the pledge
      // simply expires — no money is ever taken, nothing is lost.
      clearCart();
      track('checkout_complete', { 'pledge.total_cents': totalCents });
      if (result.donate_url) {
        window.location.href = result.donate_url;
      }
      return result;
    } catch (e) {
      track('checkout_error', { 'error.reason': (e as Error).message });
      setCheckoutError(apiErrorMessage(e, 'Failed to create pledge'));
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [email, comment, displayName, cart, topUpCents, selectedChannelId, totalCents, clearCart]);

  const value: CartContextValue = {
    rewards,
    polls,
    goals,
    loading,
    channels,
    selectedChannelId,
    refreshChannels,
    selectChannel,
    pendingChannelId,
    confirmChannelSwitch,
    cancelChannelSwitch,
    cart,
    addToCart,
    removeFromCart,
    incrementRewardQuantity,
    decrementRewardQuantity,
    cartTotal,
    topUp,
    setTopUp,
    topUpCents,
    email,
    setEmail,
    comment,
    setComment,
    displayName,
    setDisplayName,
    totalCents,
    markVisited,
    unvisitedAvailableCategories,
    hasVisited,
    drawerOpen,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    submitting,
    checkoutError,
    setCheckoutError,
    checkout,
    revalidateCart,
    prefillFromLink,
    staleRewardIds,
    stalePollIds,
    staleOptionIds,
    staleGoalIds,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
