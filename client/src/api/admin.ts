import axios, { type AxiosInstance } from 'axios';
import type {
  AdminClaim,
  AdminDonorList,
  AdminDonorWallet,
  RefundResult,
  WebhookDelivery,
  WebhookEndpoint,
} from '../types';

// The httpOnly donor session cookie rides along automatically (withCredentials)
// so an ADMIN-role donor authenticates without a key (ADR 0003). When an
// operational admin key is stored it is always sent as a Bearer credential —
// the server checks the key first, so this never conflicts with a donor
// session.
const adminClient: AxiosInstance = axios.create({ baseURL: '/api/admin', withCredentials: true });

adminClient.interceptors.request.use((config) => {
  const key = localStorage.getItem('admin_key');
  if (key) {
    config.headers.Authorization = `Bearer key_admin_${key}`;
  }
  return config;
});

export async function getDonors(q = '', offset = 0): Promise<AdminDonorList> {
  const { data } = await adminClient.get('/donors', { params: { q, offset } });
  return data;
}

export async function createDonor(
  email: string,
  role?: 'USER' | 'MODERATOR' | 'ADMIN',
): Promise<{ id: string }> {
  const { data } = await adminClient.post('/donors', { email, role });
  return data;
}

export async function getDonorWallet(id: string): Promise<AdminDonorWallet> {
  const { data } = await adminClient.get(`/donors/${id}`);
  return data;
}

export async function revokeDonorToken(id: string): Promise<{ success: boolean }> {
  const { data } = await adminClient.post(`/donors/${id}/revoke-token`);
  return data;
}

export async function regenerateDonorToken(
  id: string,
): Promise<{ success: boolean; email: string; magic_token: string | null }> {
  const { data } = await adminClient.post(`/donors/${id}/regenerate-token`);
  return data;
}

export async function toggleDonorFreeze(
  id: string,
  frozen: boolean,
): Promise<{ success: boolean }> {
  const { data } = await adminClient.post(`/donors/${id}/freeze`, { frozen });
  return data;
}

export async function setDonorRole(
  id: string,
  role: 'USER' | 'MODERATOR' | 'ADMIN',
): Promise<{ success: boolean }> {
  const { data } = await adminClient.patch(`/donors/${id}/role`, { role });
  return data;
}

export async function adjustDonorBalance(
  id: string,
  amount_cents: number,
  reason: string | null,
  type: string,
): Promise<{ success: boolean }> {
  const { data } = await adminClient.post(`/donors/${id}/adjust-balance`, {
    amount_cents,
    reason,
    type,
  });
  return data;
}

export async function reverseDonorSpend(
  id: string,
  spend_type: string,
  spend_id: string,
): Promise<{ success: boolean }> {
  const { data } = await adminClient.post(`/donors/${id}/reverse-spend`, { spend_type, spend_id });
  return data;
}

export interface SweepCreditsResult {
  preview?: boolean;
  success?: boolean;
  donor_count: number;
  total_cents: number;
  sample?: { id: string; balance_remaining: number; donor_name: string | null }[];
}

export async function sweepCredits(
  filter: { min_balance_cents?: number; max_balance_cents?: number },
  confirm: boolean,
): Promise<SweepCreditsResult> {
  const { data } = await adminClient.post('/donors/sweep-credits', { ...filter, confirm });
  return data;
}

export async function refundPollOption(id: string): Promise<RefundResult> {
  const { data } = await adminClient.post(`/polls/options/${id}/refund`);
  return data;
}

export async function refundGoal(id: string): Promise<RefundResult> {
  const { data } = await adminClient.post(`/goals/${id}/refund`);
  return data;
}

export async function getClaims(): Promise<AdminClaim[]> {
  const { data } = await adminClient.get('/claims');
  return data;
}

export async function updateClaimStatus(id: string, status: string): Promise<AdminClaim> {
  const { data } = await adminClient.patch(`/claims/${id}`, { status });
  return data;
}

export async function getDestinations(): Promise<WebhookEndpoint[]> {
  const { data } = await adminClient.get('/destinations');
  return data;
}

export async function createDestination(payload: {
  destination_type?: 'HTTP' | 'RABBITMQ';
  url?: string;
  secret?: string;
  event_types: string[];
  verify_ssl?: boolean;
  description?: string;
  amqp_url?: string;
  amqp_exchange?: string;
  amqp_routing_key?: string;
}): Promise<WebhookEndpoint> {
  const { data } = await adminClient.post('/destinations', payload);
  return data;
}

export async function updateDestination(
  id: string,
  payload: {
    destination_type?: 'HTTP' | 'RABBITMQ';
    url?: string;
    event_types?: string[];
    verify_ssl?: boolean;
    is_active?: boolean;
    description?: string;
    amqp_url?: string;
    amqp_exchange?: string;
    amqp_routing_key?: string;
  },
): Promise<WebhookEndpoint> {
  const { data } = await adminClient.put(`/destinations/${id}`, payload);
  return data;
}

export async function rotateDestinationSecret(id: string): Promise<WebhookEndpoint> {
  const { data } = await adminClient.post(`/destinations/${id}/rotate-secret`);
  return data;
}

export async function deleteDestination(id: string): Promise<{ success: boolean }> {
  const { data } = await adminClient.delete(`/destinations/${id}`);
  return data;
}

export async function getDestinationDeliveries(
  id: string,
  limit = 50,
  offset = 0,
): Promise<{ deliveries: WebhookDelivery[]; total: number }> {
  const { data } = await adminClient.get(`/destinations/${id}/deliveries`, {
    params: { limit, offset },
  });
  return data;
}

export async function testDestination(id: string): Promise<{ success: boolean; seq: number }> {
  const { data } = await adminClient.post(`/destinations/${id}/test`);
  return data;
}

/** Upload a reward image via the shared moderator upload endpoint.
 *  The admin bearer key satisfies moderatorAuth, so no separate admin
 *  upload route is needed. */
export async function uploadRewardImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await adminClient.post('/api/moderator/uploads', fd, {
    baseURL: '/',
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data.url as string;
}

export default adminClient;
