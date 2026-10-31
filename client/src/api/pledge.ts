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
/** Read-only live default-goal chain. Rechecked at fulfillment, not a reservation. */
export const getDefaultGoalPreview = (
  channelId: string,
): Promise<{ goal: { id: string; title: string } | null }> =>
  client.get(`/pledge/default-goal/${channelId}`).then((r) => r.data);
