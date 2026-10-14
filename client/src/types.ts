import type { PledgePlan } from '@dono/shared';

// Shared client-side domain types. These describe the JSON shapes returned by
// the server API as consumed by the React pages. Fields are intentionally
// limited to what the UI actually reads.

/** Extract a human-readable error string from an axios error (or anything). */
export function apiErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === 'object' && e !== null && 'response' in e) {
    const resp = (e as { response?: { data?: { error?: unknown } } }).response;
    const err = resp?.data?.error;
    if (typeof err === 'string') return err;
  }
  return fallback;
}

export type Role = 'USER' | 'MODERATOR' | 'ADMIN';

/** True for MODERATOR and ADMIN (admin implies moderator access). */
export function hasModeratorAccess(role: Role | string | null | undefined): boolean {
  return role === 'MODERATOR' || role === 'ADMIN';
}

/** True for ADMIN only. */
export function hasAdminAccess(role: Role | string | null | undefined): boolean {
  return role === 'ADMIN';
}

export interface Donor {
  id: string;
  email: string;
  balance_remaining: number;
  total_donated: number;
  role?: Role;
  is_frozen?: boolean;
}

export interface DonationRecord {
  id: string;
  amount_cents: number;
  comment?: string | null;
  donor_name?: string | null;
  created_at: string;
  donor?: { email?: string } | null;
  // Which channel this donation was routed to, or null/absent for a shared
  // (unscoped) donation (#53).
  channel?: { id: string; name: string } | null;
}

export interface RewardSummary {
  title: string;
  cost_cents: number;
  type?: string;
}

export interface RewardClaim {
  id: string;
  status: string;
  amount_cents: number;
  claim_data?: unknown;
  created_at?: string;
  reward: RewardSummary;
  donor?: { email?: string } | null;
}

export interface WalletPollVote {
  id: string;
  amount_cents: number;
  reversed_at?: string | null;
  created_at: string;
  poll: { title: string };
  poll_option: { label: string; status?: string };
}

export interface WalletContribution {
  id: string;
  amount_cents: number;
  reversed_at?: string | null;
  created_at: string;
  goal: { title: string };
}

export interface WalletCustomEntry {
  id: string;
  label: string;
  status: string;
  created_at: string;
  poll: { title: string };
  option?: { votes_cents: number; status: string } | null;
}

export interface WalletBid {
  id: string;
  amount_cents: number;
  status: string;
  created_at: string;
  auction: { title: string; status: string };
}

export interface WalletAuctionOffer {
  id: string;
  amount_cents: number;
  checkout_url?: string | null;
  expires_at: string;
  auction: { title: string };
}

export interface WalletAuctionWin {
  id: string;
  winning_bid_cents: number;
  status: string;
  created_at: string;
  auction: { title: string };
}

export interface DonorWallet extends Donor {
  donations: DonationRecord[];
  reward_claims: RewardClaim[];
  poll_votes: WalletPollVote[];
  fund_contributions: WalletContribution[];
  custom_entries: WalletCustomEntry[];
  bids?: WalletBid[];
  auction_offers?: WalletAuctionOffer[];
  auction_wins?: WalletAuctionWin[];
}

export interface Reward {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  cost_cents: number;
  quantity_total: number | null;
  quantity_claimed: number;
  is_active?: boolean;
  custom_type_label?: string | null;
  image_url?: string | null;
  channel_id?: string | null;
}

export interface PollOption {
  id: string;
  label: string;
  votes_cents: number;
  status?: string;
  custom_entry_id?: string | null;
}

export interface Poll {
  id: string;
  title: string;
  description?: string | null;
  options: PollOption[];
  total_votes_cents: number;
  ends_at?: string | null;
  is_active?: boolean;
  allow_custom_entries?: boolean;
  max_entry_chars?: number | null;
  auto_approve?: boolean;
  custom_entries?: CustomEntry[];
  channel_id?: string | null;
}

export interface CustomEntry {
  id: string;
  label: string;
  status: string;
  option?: { status: string; votes: { amount_cents: number }[] } | null;
}

export interface Goal {
  id: string;
  title: string;
  description?: string | null;
  current_cents: number;
  target_cents: number;
  is_complete?: boolean;
  is_active?: boolean;
  channel_id?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  slug: string;
  event_id: string;
  is_active: boolean;
  /** Ordered own/shared goal ids. Ineligible entries are preserved. */
  default_goals?: string[];
}

/** A charity Event (a marathon, or a one-day stream event) that groups
 *  Channels. Only active Events are open for donations. */
export interface Event {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  ended_at: string | null;
  ended_by: string | null;
  end_undone_at: string | null;
  end_undone_by: string | null;
  // Where donations that name no channel are routed. Required (and must be an
  // active channel of this event) before the event can be activated.
  primary_channel_id: string | null;
  created_at: string;
  updated_at: string;
}

export type UnusedCategory = 'poll' | 'goal';
export interface UnusedAssignment {
  id: string;
  category: UnusedCategory;
  label: string;
  amount_cents: number;
  allocated_at: string | null;
  can_undo: boolean;
}
export interface UnusedDonation {
  id: string;
  donor_name: string | null;
  comment: string | null;
  created_at: string;
  channel_id: string | null;
  event: { id: string; name: string; ended_at: string | null } | null;
  unused_cents: Record<UnusedCategory, number>;
  assignments: UnusedAssignment[];
}
export interface UnusedPicker {
  amount_cents: number;
  targets: {
    id: string;
    label: string;
    channel_id: string | null;
    before_cents: number;
    after_cents: number;
    target_cents: number | null;
  }[];
}
export interface EventEndPreview {
  event_id: string;
  slug: string;
  action: 'END' | 'UNDO_END';
  can_apply: boolean;
  blockers: string[];
  pool_credit_cents: Record<'reward' | 'poll' | 'goal', number>;
  unshipped_physical_donations: number;
  open_pledges: number;
  requested_payment_refunds: number;
  consuming_assignments: {
    donation_id: string;
    category: UnusedCategory;
    assignment_ids: string[];
  }[];
}

/** Public view of an active Event with its active Channels (#115). Used by the
 *  /donate/<event>[/<channel>] link tree; internal fields are omitted. */
export interface PublicEvent {
  id: string;
  name: string;
  slug: string;
  primary_channel_id: string | null;
  channels: Channel[];
}

export type AuctionStatus =
  'OPEN' | 'CLOSED' | 'AWAITING_PAYMENT' | 'SETTLED' | 'UNSOLD' | 'CANCELLED';

export interface Auction {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  custom_type_label?: string | null;
  image_url?: string | null;
  starting_price_cents: number;
  min_increment_cents: number;
  current_bid_cents: number | null;
  current_bidder_id?: string | null;
  min_next_bid_cents: number | null;
  ends_at: string;
  status: AuctionStatus;
  is_active?: boolean;
  channel_id?: string | null;
  is_current_highest_bidder?: boolean;
  bids?: { id: string; amount_cents: number; status: string; created_at: string }[];
}

export interface AuctionBid {
  id: string;
  auction_id: string;
  donor_id: string;
  amount_cents: number;
  rank?: number | null;
  status: string;
  created_at: string;
}

export interface AuctionOffer {
  id: string;
  auction_id: string;
  donor_id: string;
  bid_id: string;
  rank: number;
  amount_cents: number;
  checkout_url?: string | null;
  status: string;
  expires_at: string;
  emailed_at?: string | null;
}

export interface AuctionWin {
  id: string;
  auction_id: string;
  donor_id: string;
  winning_bid_cents: number;
  status: string;
  created_at: string;
  auction?: { title: string };
  donor?: { email?: string };
}

export interface Campaign {
  name?: string;
  title?: string;
  description?: string;
  logo?: { src?: string };
  amount_raised?: { value?: string };
  total_amount_raised?: { value?: string };
  goal?: { value?: string };
  fundraising_goal?: { value?: string };
}

/** A browser-local donor selection. Live prices are revalidated before review. */
export interface DraftSelection {
  insertion_order?: number;
  channel_id?: string | null;
  unit_price_cents?: number | null;
  reward_type?: string | null;
  kind: 'REWARD' | 'POLL_VOTE' | 'GOAL' | 'POLL_CUSTOM';
  target_id: string;
  amount_cents: number;
  poll_id?: string;
  label?: string;
  data?: Record<string, string> | { label: string };
  /** REWARD only: number of units this line claims. amount_cents is always
   *  the line total (unit cost_cents * quantity), never the unit price.
   *  Defaults to 1 when omitted. */
  quantity?: number;
}

export interface PledgeItem {
  id?: string;
  kind: string;
  target_id: string;
  amount_cents: number;
  poll_id?: string | null;
  data?: string | null;
  quantity?: number;
  source?: 'donor' | 'auto';
  unit_price_cents?: number | null;
  confirmed_reward_type?: string | null;
}

export type PledgePaymentState =
  | 'READY'
  | 'OPEN'
  | 'PROCESSING'
  | 'UNKNOWN'
  | 'NON_PAYMENT'
  | 'FULFILLED'
  | 'LEGACY_PAID'
  | 'PAYMENT_REVIEW';

interface PledgeBase {
  comment: string | null;
  display_name: string | null;
  channel_id: string | null;
  payment_state: PledgePaymentState;
  can_edit: boolean;
  can_continue: boolean;
  read_only: boolean;
  admin_review_required: boolean;
  donate_url: string | null;
  has_checkout: boolean;
  pledge_token: string;
  status: string;
  expires_at: string;
  items: PledgeItem[];
}
export interface PooledPledge extends PledgeBase {
  format: 'POOLED';
  draft_id: string;
  pledge_amount_cents: number;
  wallet_applied_cents: number;
  new_money_cents: number;
  requires_shipping: boolean;
  plan: PledgePlan;
}
export interface LegacyPledge extends PledgeBase {
  format: 'LEGACY';
  total_cents: number;
  top_up_cents: number;
}
/** Legacy pledges can only be read; new POST responses never contain old totals. */
export type Pledge = PooledPledge | LegacyPledge;
export interface PledgeResult extends PooledPledge {
  checkout_error: string | null;
}

// ─── Admin/moderator shapes ───

export interface AdminStats {
  total_raised_cents: number;
  donors: number;
  donations: number;
  claims: number;
  pledges: number;
  // Sum of Donor.balance_remaining across all donors (#59) — credited but
  // not yet spent on a reward/poll/goal.
  unallocated_credits_cents?: number;
  channels?: { id: string; name: string; raised_cents: number; donations: number }[];
}

export interface BlockedWord {
  id: string;
  word: string;
}

export type DonationStatus = 'PENDING' | 'COMPLETED' | 'REFUNDED' | 'CHARGEBACK';

export interface AdminDonation {
  id: string;
  amount_cents: number;
  donor_name?: string | null;
  comment?: string | null;
  created_at: string;
  donor?: { email?: string } | null;
  moderated?: boolean;
  moderated_at?: string | null;
  moderated_by?: string | null;
  // PRD-0002 §N2: hidden donations stay in the totals but are pulled from the
  // stream overlay until a moderator un-hides them (#116).
  hidden_from_overlay?: boolean;
  channel?: { id: string; name: string } | null;
  // Routing (#115). Both null means the donation arrived while no single event
  // was active — it stays unassigned until an admin assigns a channel.
  channel_id?: string | null;
  event_id?: string | null;
  status: DonationStatus;
  refund_id?: string | null;
  // What the donor selected/pledged toward (#58) — human-readable labels
  // only (e.g. "Best Runner: Runner A", "T-shirt"), never a raw target_id.
  // Only present on the moderator donations list; undefined elsewhere.
  pledge_items?: { kind: string; label: string; amount_cents: number }[];
  top_up_cents?: number | null;
}

export interface AdminClaim {
  id: string;
  status: string;
  claim_data?: unknown;
  created_at: string;
  donor?: { email?: string } | null;
  // Human-readable donor identity for the moderator view (#57) — sourced
  // from the donor's most recent Donation.donor_name, never email/id.
  donor_name?: string | null;
  reward?: {
    title?: string;
    type?: string;
    cost_cents?: number;
    channel_id?: string | null;
  } | null;
}

export interface SpendRecord {
  id: string;
  amount_cents: number;
  reversed_at?: string | null;
  status?: string;
  reward?: { title?: string; cost_cents?: number } | null;
  goal?: { title?: string } | null;
}

export interface BalanceAdjustment {
  id: string;
  amount_cents: number;
  type: string;
  reason?: string | null;
  balance_after_cents: number;
}

export interface AdminDonorSummary {
  id: string;
  email: string;
  total_donated: number;
  balance_remaining: number;
  is_frozen?: boolean;
}

export interface AdminDonorWallet {
  email?: string;
  total_donated: number;
  balance_remaining: number;
  role?: Role;
  is_frozen?: boolean;
  donations?: DonationRecord[];
  reward_claims?: SpendRecord[];
  poll_votes?: SpendRecord[];
  fund_contributions?: SpendRecord[];
  balance_adjustments?: BalanceAdjustment[];
}

export type WebhookMessageType =
  | 'donation.created'
  | 'donation.updated'
  | 'donation.moderated'
  | 'donation.hidden'
  | 'donation.unhidden'
  | 'incentive.created'
  | 'incentive.enabled'
  | 'incentive.disabled'
  | 'incentive.value_changed';

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  is_active: boolean;
  event_types: string[];
  verify_ssl: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
  destination_type: 'HTTP' | 'RABBITMQ';
  payload_format: 'NATIVE' | 'TILTIFY';
  amqp_url: string | null;
  amqp_exchange: string;
  amqp_routing_key: string | null;
}

export interface WebhookDelivery {
  id: string;
  seq: number;
  message_id: string;
  event_type: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminDonorList {
  donors: AdminDonorSummary[];
  total: number;
}

export type PaymentRefundStatus =
  'REQUESTED' | 'PENDING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'RESOLVED';
export type PaymentRefundItemResolution =
  'RETURNED_OUTSIDE_APP' | 'WALLET_CREDIT' | 'SETTLED_BY_DISPUTE';
export type PaymentRefundShippingResolution = 'RETURNED_OUTSIDE_APP' | 'KEPT_BY_AGREEMENT';
export interface PaymentRefundRecord {
  id: string;
  donation_id: string;
  claim_id: string;
  item_cents: number;
  shipping_cents: number;
  status: PaymentRefundStatus;
  stripe_refund_id: string | null;
  /** JSON-encoded PaymentRefundShrink; null until accepted. */
  pool_shrink_data: string | null;
  failure_reason: string | null;
  resolution: 'REJECTED' | PaymentRefundItemResolution | null;
  shipping_resolution: PaymentRefundShippingResolution | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  shipping_resolved_at: string | null;
  shipping_resolved_by: string | null;
}
export interface PaymentRefundList {
  records: PaymentRefundRecord[];
  total: number;
  offset: number;
  limit: number;
}
export interface PaymentRefundShrink {
  donation_id: string;
  claim_id: string;
  money_before_cents: number;
  money_after_cents: number;
  pledge_before_cents: number;
  pledge_after_cents: number;
  wallet_applied_cents: number;
  failed_payment_wallet_credit_cents: number;
  affected_targets: {
    category: 'poll' | 'goal';
    target_id: string;
    poll_id: string | null;
    label: string;
    before_cents: number;
    after_cents: number;
    ended: boolean;
    completed: boolean;
  }[];
  categories: Record<
    'reward' | 'poll' | 'goal',
    {
      before_cents: number;
      after_cents: number;
      unused_consumed_cents: number;
      reduced_cents: number;
    }
  >;
  components: {
    kind: 'claim' | 'vote' | 'contribution' | 'redemption' | 'credit';
    id: string;
    category: 'reward' | 'poll' | 'goal';
    before_cents: number;
    after_cents: number;
    target_id: string | null;
    allocation_id: string | null;
    ended: boolean;
    completed: boolean;
    reduced_before_cents: number;
    reduced_after_cents: number;
  }[];
}
export type PaymentRefundPreview =
  | { eligible: false; reason: string; claim_id: string; donation_id: string | null }
  | {
      eligible: true;
      reason: null;
      claim_id: string;
      donation_id: string;
      item_cents: number;
      shipping_cents: number;
      money_before_cents: number;
      money_after_cents: number;
      pledge_before_cents: number;
      pledge_after_cents: number;
      wallet_applied_cents: number;
      pool_shrink: PaymentRefundShrink;
    };

export interface RefundResult {
  success: boolean;
  refunded_count: number;
  refunded_cents: number;
}

export interface AdminPledgeItem {
  id: string;
  kind: string;
  target_id: string;
  amount_cents: number;
  poll_id?: string | null;
  data?: string | null;
}

export interface AdminPledge {
  format: 'POOLED' | 'LEGACY';
  pledge_amount_cents: number | null;
  new_money_cents: number | null;
  held_wallet_cents: number;
  wallet_hold_status: 'NONE' | 'HELD' | 'CONSUMED' | 'RELEASED';
  payment_status: string | null;
  checkout_session_status: string | null;
  non_payment_confirmed_at: string | null;
  reconciled_at: string | null;
  admin_review_required: boolean;
  id: string;
  status: string;
  donor_email?: string | null;
  total_cents: number;
  items: AdminPledgeItem[];
  relay_client_key?: string | null;
  relay_key_id?: string | null;
  expires_at: string;
  created_at: string;
  fulfilled_by?: { donor?: { email?: string } | null; amount_cents: number } | null;
}

/** Generic editable form record used by admin/moderator CRUD modals. */
export type FormRecord = Record<string, string | number | boolean | null | undefined>;

export interface ModeratorStats {
  pending_entries: number;
  active_polls: number;
  total_rewards: number;
  total_goals: number;
}
