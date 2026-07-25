import client from './client';
import type { Reward } from '../types';
export const getRewards = (): Promise<Reward[]> => client.get('/rewards').then((r) => r.data);
export const claimReward = (id: string, claim_data: Record<string, string>): Promise<unknown> =>
  client.post(`/rewards/${id}/claim`, { claim_data }).then((r) => r.data);
