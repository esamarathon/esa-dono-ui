import client from './client';
import type { DonorWallet, SessionInfo } from '../types';
import type {
  CreditApplyRequest,
  CreditApplyResult,
  CreditEvent,
  CreditEventSummary,
} from '@dono/shared';
export const getDonor = (): Promise<DonorWallet> => client.get('/donor').then((r) => r.data);

/**
 * Anonymous-tolerant session probe (issue #135): GET /api/auth/session always
 * resolves 200, so a logged-out visit never logs a failed request in the
 * browser console. Use this wherever the UI only needs "logged in or not" (or
 * the small donor identity); use getDonor() only when the full wallet is
 * required.
 */
export const getSession = (): Promise<SessionInfo> =>
  client.get('/auth/session').then((r) => r.data);

export const getPoolCredits = (): Promise<{
  wallet_credit_cents: number;
  events: CreditEventSummary[];
}> => client.get('/donor/pool-credits').then((r) => r.data);
export const getPoolCreditEvent = (eventId: string): Promise<CreditEvent> =>
  client.get(`/donor/pool-credits/${eventId}`).then((r) => r.data);
export const applyPoolCredits = (
  eventId: string,
  batch: CreditApplyRequest,
): Promise<CreditApplyResult> =>
  client.post(`/donor/pool-credits/${eventId}/apply`, batch).then((r) => r.data);

export const requestToken = (email: string): Promise<{ success: boolean }> =>
  client.post('/auth/request-token', { email }).then((r) => r.data);
