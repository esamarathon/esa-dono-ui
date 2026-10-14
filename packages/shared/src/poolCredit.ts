import type { PoolCategory } from './pledgePlan.js';
export type CreditAmounts = Record<PoolCategory, number>;
export type CreditSelection =
  | {
      kind: 'REWARD';
      target_id: string;
      quantity: number;
      unit_price_cents: number;
      reward_type: string;
    }
  | { kind: 'POLL_VOTE'; target_id: string; poll_id: string; amount_cents: number }
  | { kind: 'GOAL'; target_id: string; amount_cents: number };
export interface CreditApplyRequest {
  idempotency_key: string;
  reviewed_credit_cents: CreditAmounts;
  selections: CreditSelection[];
}
export interface CreditApplyResult {
  batch_id: string;
  spent_cents: CreditAmounts;
  claim_ids: string[];
  vote_ids: string[];
  contribution_ids: string[];
  donation_ids: string[];
}
export interface CreditEventSummary {
  event: { id: string; name: string; slug: string; ended_at: string | null };
  outstanding_cents: CreditAmounts;
  available_cents: CreditAmounts;
  reasons: Record<PoolCategory, string | null>;
}
export interface CreditCatalogTarget {
  id: string;
  title: string;
  channel: { id: string; name: string; slug: string } | null;
}
export interface CreditEvent extends CreditEventSummary {
  catalog: {
    rewards: (CreditCatalogTarget & {
      cost_cents: number;
      type: string;
      remaining: number | null;
    })[];
    polls: (CreditCatalogTarget & {
      options: { id: string; label: string; votes_cents: number }[];
      total_votes_cents: number;
    })[];
    goals: (CreditCatalogTarget & { current_cents: number; target_cents: number })[];
  };
  history: {
    id: string;
    donation_id: string;
    category: PoolCategory;
    amount_cents: number;
    remaining_cents: number;
    created_at: string;
    cleared_at: string | null;
    origin: { kind: 'claim' | 'vote' | 'contribution'; id: string; title: string };
    redemptions: {
      id: string;
      /** Original consumption, retained even after a Payment refund shrinks funding. */
      amount_cents: number;
      reduced_cents: number;
      effective_cents: number;
      created_at: string;
      allocation_id: string;
      reversed: boolean;
    }[];
  }[];
}
