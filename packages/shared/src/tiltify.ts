/**
 * Types for inbound Tiltify webhook payloads. These describe external JSON that
 * is hand-parsed in server/routes/webhook.ts, so every field is optional and
 * must be narrowed at runtime.
 */

export interface TiltifyDonor {
  email?: string;
  name?: string;
}

export interface TiltifyCampaignDonation {
  donor?: TiltifyDonor;
  comment?: string | null;
}

export interface TiltifyAmount {
  value?: string | number;
}

export interface TiltifyDonationData {
  id?: string | number;
  legacy_id?: string | number;
  donor_email?: string;
  donor_name?: string;
  amount?: TiltifyAmount | string | number;
  comment?: string | null;
  payment_status?: string;
  campaign_donation?: TiltifyCampaignDonation;
}

export interface TiltifyWebhookMeta {
  event_type?: string;
  relay_key_id?: string;
}

export interface TiltifyWebhookPayload {
  meta?: TiltifyWebhookMeta;
  type?: string;
  data?: TiltifyDonationData;
  donation?: TiltifyDonationData;
}

/** Normalized donation extracted from a webhook payload. */
export interface NormalizedDonation {
  tiltifyId: string;
  email: string;
  donorName: string;
  amountCents: number;
  comment: string | null;
  pledgeToken: string | null;
}
