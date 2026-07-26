import client from './client';
import type { Poll } from '../types';
export const getPolls = (): Promise<Poll[]> => client.get('/polls').then((r) => r.data);
export const votePoll = (
  id: string,
  poll_option_id: string,
  amount_cents: number,
): Promise<unknown> =>
  client.post(`/polls/${id}/vote`, { poll_option_id, amount_cents }).then((r) => r.data);
export const submitCustomEntry = (
  pollId: string,
  label: string,
  amount_cents: number,
): Promise<{
  success: boolean;
  pending_approval: boolean;
  entry: { id: string; label: string; status: string };
}> => client.post(`/polls/${pollId}/custom-entry`, { label, amount_cents }).then((r) => r.data);
