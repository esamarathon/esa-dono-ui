import client from './client';
import type { Goal } from '../types';
export const getGoals = (): Promise<Goal[]> => client.get('/goals').then((r) => r.data);
export const contributeGoal = (id: string, amount_cents: number): Promise<unknown> =>
  client.post(`/goals/${id}/contribute`, { amount_cents }).then((r) => r.data);
