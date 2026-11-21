import client from './client';
import type { DraftSelection, PledgeResult, Pledge } from '../types';
import type { PledgePlan } from '@dono/shared';

export interface CreatePledgeInput {
  email?: string;
  comment?: string;
  display_name?: string;
  channel_id: string;
  pledge_amount_cents: number;
  draft_id: string;
  plan: PledgePlan;
  items: Array<
    Pick<
      DraftSelection,
      'kind' | 'target_id' | 'amount_cents' | 'quantity' | 'insertion_order' | 'poll_id' | 'data'
    >
  >;
}
export const createPledge = (data: CreatePledgeInput): Promise<PledgeResult> =>
  client.post('/pledge', data).then((r) => r.data);
export const getPledge = (token: string): Promise<Pledge> =>
  client.get(`/pledge/${token}`).then((r) => r.data);
/** Reconciliation never establishes authentication. */
export const reconcilePledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/reconcile`).then((r) => r.data);
export const cancelPledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/cancel`).then((r) => r.data);
export const continuePledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/continue`).then((r) => r.data);
export interface DefaultGoalPreview {
  goal: { id: string; title: string } | null;
  /** The next goals that would take goal-Pool money, in order (#201 preview). */
  chain: Array<{ id: string; title: string; remaining_cents: number }>;
}
/** Read-only live default-goal chain. Rechecked at fulfillment, not a reservation. */
export const getDefaultGoalPreview = (channelId: string): Promise<DefaultGoalPreview> =>
  client.get(`/pledge/default-goal/${channelId}`).then((r) => r.data);
