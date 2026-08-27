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
  apiErrorMessage,
  type CartItem,
  type Reward,
  type Poll,
  type Goal,
  type Channel,
  type PledgeResult,
} from '../types';

const CART_STORAGE_KEY = 'donation_cart_v1';
const EMAIL_STORAGE_KEY = 'last_donor_email';

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

  const [visited, setVisited] = useState<Set<IncentiveCategory>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');

  const fetchAll = useCallback(async () => {
    const [r, p, g, s] = await Promise.all([getRewards(), getPolls(), getGoals(), getChannels()]);
    setAllRewards(r);
    setAllPolls(p);
    setAllGoals(g);
    setChannels(s);
    return { r, p, g, s };
  }, []);

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
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
        updated[idx] = { ...updated[idx]!, amount_cents: item.amount_cents, data: item.data };
        return updated;
      }
      return [...prev, item];
    });
  }, []);

  const removeFromCart = useCallback((kind: CartItem['kind'], targetId: string) => {
    track('cart_remove', { 'item.kind': kind, 'item.target_id': targetId });
    setCart((prev) => prev.filter((i) => !(i.kind === kind && i.target_id === targetId)));
  }, []);

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
          reward.quantity_total !== null && reward.quantity_claimed >= reward.quantity_total;
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
            top_up_cents: topUpCents > 0 ? topUpCents : undefined,
            channel_id: selectedChannelId,
            items: cart.map((item) => ({
              kind: item.kind,
              target_id: item.target_id,
              amount_cents: item.amount_cents,
              poll_id: item.poll_id,
              data: item.data,
            })),
          }),
        { 'pledge.total_cents': totalCents },
      );
      localStorage.setItem(EMAIL_STORAGE_KEY, email.trim());
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
  }, [email, comment, cart, topUpCents, selectedChannelId, totalCents, clearCart]);

  const value: CartContextValue = {
    rewards,
    polls,
    goals,
    loading,
    channels,
    selectedChannelId,
    selectChannel,
    pendingChannelId,
    confirmChannelSwitch,
    cancelChannelSwitch,
    cart,
    addToCart,
    removeFromCart,
    cartTotal,
    topUp,
    setTopUp,
    topUpCents,
    email,
    setEmail,
    comment,
    setComment,
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
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
