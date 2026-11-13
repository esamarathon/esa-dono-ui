import client from './client';
import type { FeedbackMetadata } from '@dono/shared';

export type { FeedbackMetadata };

export interface SendFeedbackParams {
  text: string;
  metadata: FeedbackMetadata;
  /** Decimal string of the page scroll position at capture time. */
  scrollY?: number;
  screenshot?: Blob | null;
  /** DOM snapshot of the page with its live form values. */
  snapshot?: Blob | null;
  /** Bounded client error record (client/src/lib/feedback/diagnostics.ts). */
  diagnostics?: string | null;
}

export async function sendFeedback(params: SendFeedbackParams): Promise<{ success: boolean }> {
  const form = new FormData();
  form.append('text', params.text);
  form.append('metadata', JSON.stringify(params.metadata));
  if (params.scrollY !== undefined) form.append('scrollY', String(Math.round(params.scrollY)));
  if (params.screenshot) {
    form.append('screenshot', params.screenshot, 'screenshot.jpg');
  }
  if (params.snapshot) {
    form.append('snapshot', params.snapshot, 'snapshot.html');
  }
  if (params.diagnostics) {
    form.append('diagnostics', params.diagnostics);
  }
  const response = await client.post('/feedback', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}
