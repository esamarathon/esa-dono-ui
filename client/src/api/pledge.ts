import client from './client';
import type { CartItem, PledgeResult, Pledge } from '../types';
import type { PledgePlan } from '@dono/shared';

/** Temporary typing for the old cart, which the server now rejects. Removed by #187. */
interface LegacyCartInput {
  email: string;
  comment?: string;
  display_name?: string;
  top_up_cents?: number;
  channel_id: string;
  items: Array<{
    kind: CartItem['kind'];
    target_id: string;
    amount_cents: number;
    quantity?: number;
    insertion_order?: number;
    poll_id?: string;
    data?: Record<string, string> | { label: string };
  }>;
}

export interface CreatePledgeInput extends Omit<LegacyCartInput, 'top_up_cents' | 'email'> {
  email?: string;
  pledge_amount_cents: number;
  draft_id: string;
  plan: PledgePlan;
}

export const createPledge = (data: CreatePledgeInput | LegacyCartInput): Promise<PledgeResult> =>
  client.post('/pledge', data).then((r) => r.data);
export const getPledge = (token: string): Promise<Pledge> =>
  client.get(`/pledge/${token}`).then((r) => r.data);

/** Reconcile only; possession of a pledge token never establishes a donor session. */
export const reconcilePledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/reconcile`).then((r) => r.data);
export const cancelPledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/cancel`).then((r) => r.data);
export const continuePledge = (token: string): Promise<Pledge> =>
  client.post(`/pledge/${token}/continue`).then((r) => r.data);
