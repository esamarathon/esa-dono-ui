import client from './client';
import type { CartItem, PledgeResult, Pledge } from '../types';

interface CreatePledgeInput {
  email: string;
  items: Array<{
    kind: CartItem['kind'];
    target_id: string;
    amount_cents: number;
    poll_id?: string;
    data?: Record<string, string> | { label: string };
  }>;
}

export const createPledge = (data: CreatePledgeInput): Promise<PledgeResult> =>
  client.post('/pledge', data).then((r) => r.data);
export const getPledge = (token: string): Promise<Pledge> =>
  client.get(`/pledge/${token}`).then((r) => r.data);
