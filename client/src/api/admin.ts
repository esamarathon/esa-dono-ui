import axios, { type AxiosInstance } from 'axios';
import type {
  AdminClaim,
  AdminDonation,
  AdminDonorList,
  AdminDonorWallet,
  Event,
  RefundResult,
  ReversalPreview,
  WebhookDelivery,
  WebhookDestinationWithSecret,
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

// ─── Events (#115) ───

export async function getEvents(): Promise<Event[]> {
  const { data } = await adminClient.get('/events');
  return data;
}

export async function createEvent(payload: { name: string; slug?: string }): Promise<Event> {
  const { data } = await adminClient.post('/events', payload);
  return data;
}

export async function updateEvent(
  id: string,
  payload: {
    name?: string;
    slug?: string;
    primary_channel_id?: string | null;
    is_active?: boolean;
  },
): Promise<Event> {
  const { data } = await adminClient.put(`/events/${id}`, payload);
  return data;
}

export async function deleteEvent(id: string): Promise<{ success: boolean; event: Event }> {
  const { data } = await adminClient.delete(`/events/${id}`);
  return data;
}

/** Assign an unassigned donation to a channel (and so its event), then publish it. */
export async function assignDonationChannel(id: string, channelId: string): Promise<AdminDonation> {
  const { data } = await adminClient.patch(`/donations/${id}/channel`, { channel_id: channelId });
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

export async function getReversalPreview(
  path: string,
  params?: { spend_type: string; spend_id: string },
): Promise<ReversalPreview> {
  const { data } = await adminClient.get(path, { params });
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
  payload_format?: 'NATIVE' | 'TILTIFY';
  url?: string;
  secret?: string;
  event_types: string[];
  verify_ssl?: boolean;
  description?: string;
  amqp_url?: string;
  amqp_exchange?: string;
  amqp_routing_key?: string;
}): Promise<WebhookDestinationWithSecret> {
  const { data } = await adminClient.post('/destinations', payload);
  return data;
}

export async function updateDestination(
  id: string,
  payload: {
    destination_type?: 'HTTP' | 'RABBITMQ';
    payload_format?: 'NATIVE' | 'TILTIFY';
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

export async function rotateDestinationSecret(id: string): Promise<WebhookDestinationWithSecret> {
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

export async function requeueDelivery(
  destinationId: string,
  deliveryId: string,
): Promise<WebhookDelivery> {
  const { data } = await adminClient.post(
    `/destinations/${destinationId}/deliveries/${deliveryId}/requeue`,
  );
  return data;
}

export async function requeueFailedDeliveries(
  destinationId: string,
): Promise<{ requeued: number; skipped_unbuilt: number }> {
  const { data } = await adminClient.post(`/destinations/${destinationId}/requeue-failed`);
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

// ─── Feedback queue (ported from the esa-crew-corner feedback bubble) ───

export interface FeedbackSenderRef {
  id: string;
  email: string | null;
}

export interface FeedbackQueueItem {
  id: string;
  ref: string;
  message: string;
  page_url: string;
  route: string;
  viewport: string;
  scroll_y: number;
  status: string;
  created_at: string;
  sender: FeedbackSenderRef | null;
  has_screenshot: boolean;
  has_snapshot: boolean;
  diagnostics_error_count: number;
  resolution_note: string;
  resolution_pr: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface FeedbackQueueResponse {
  open_count: number;
  items: FeedbackQueueItem[];
}

export interface FeedbackQueueDetail extends FeedbackQueueItem {
  user_agent: string;
  diagnostics: import('@dono/shared').FeedbackDiagnostics | null;
}

export type FeedbackQueueFilter = 'open' | 'done' | 'all';

export async function getFeedbackQueue(
  filter: FeedbackQueueFilter = 'open',
): Promise<FeedbackQueueResponse> {
  const { data } = await adminClient.get('/feedback', { params: { filter } });
  return data;
}

export async function getFeedbackItem(id: string): Promise<FeedbackQueueDetail> {
  const { data } = await adminClient.get(`/feedback/${id}`);
  return data;
}

export async function markFeedbackSeen(id: string): Promise<void> {
  await adminClient.post(`/feedback/${id}/seen`);
}

export async function updateFeedback(
  id: string,
  payload: { status: string; resolution_note?: string; resolution_pr?: string },
): Promise<{ success: boolean; status: string }> {
  const { data } = await adminClient.patch(`/feedback/${id}`, payload);
  return data;
}

/** The report's screenshot as bytes (auth rides the header, so a plain href will not do). */
export async function getFeedbackScreenshot(id: string): Promise<Blob> {
  const { data } = await adminClient.get(`/feedback/${id}/screenshot`, { responseType: 'blob' });
  return data as Blob;
}

/** The report's DOM snapshot HTML; open it in a browser to re-render the page. */
export async function getFeedbackSnapshot(id: string): Promise<string> {
  const { data } = await adminClient.get(`/feedback/${id}/snapshot`, { responseType: 'text' });
  return data as string;
}

export default adminClient;
