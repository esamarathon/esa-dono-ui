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
}

export interface RewardSummary {
  title: string;
  cost_cents: number;
  type?: string;
}

export interface RewardClaim {
  id: string;
  status: string;
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
  is_active: boolean;
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
  bids?: { id: string; amount_cents: number; status: string; created_at: string }[];
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

/** An item in the donation cart (client-side only). */
export interface CartItem {
  kind: 'REWARD' | 'POLL_VOTE' | 'GOAL' | 'POLL_CUSTOM';
  target_id: string;
  amount_cents: number;
  poll_id?: string;
  label?: string;
  data?: Record<string, string> | { label: string };
}

export interface PledgeItem {
  id?: string;
  kind: string;
  target_id: string;
  amount_cents: number;
  poll_id?: string | null;
  data?: string | null;
}

export interface PledgeResult {
  total_cents: number;
  donate_url?: string | null;
  wallet_discount_cents?: number;
}

export interface Pledge {
  status: string;
  total_cents: number;
  top_up_cents?: number;
  expires_at: string;
  magic_token?: string | null;
  items: PledgeItem[];
}

// ─── Admin/moderator shapes ───

export interface AdminStats {
  total_raised_cents: number;
  donors: number;
  donations: number;
  claims: number;
  pledges: number;
  channels?: { id: string; name: string; raised_cents: number; donations: number }[];
}

export interface BlockedWord {
  id: string;
  word: string;
}

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
  channel?: { id: string; name: string } | null;
}

export interface AdminClaim {
  id: string;
  status: string;
  claim_data?: unknown;
  created_at: string;
  donor?: { email?: string } | null;
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
  reward_claims?: SpendRecord[];
  poll_votes?: SpendRecord[];
  fund_contributions?: SpendRecord[];
  balance_adjustments?: BalanceAdjustment[];
}

export type WebhookEventType =
  | 'donation.created'
  | 'donation.moderated'
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
  amqp_url: string | null;
  amqp_exchange: string;
  amqp_routing_key: string | null;
}

export interface WebhookDelivery {
  id: string;
  seq: number;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminDonorList {
  donors: AdminDonorSummary[];
  total: number;
}

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
