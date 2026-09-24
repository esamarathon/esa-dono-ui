import client from './client';

export interface FeedbackMetadata {
  url?: string;
  donorId?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  userAgent?: string;
  viewport?: string;
  cartSummary?: string;
}

export async function sendFeedback(params: {
  text: string;
  metadata: FeedbackMetadata;
  screenshot?: Blob | null;
}): Promise<{ success: boolean }> {
  const form = new FormData();
  form.append('text', params.text);
  form.append('metadata', JSON.stringify(params.metadata));
  if (params.screenshot) {
    form.append('screenshot', params.screenshot, 'screenshot.jpg');
  }
  const response = await client.post('/feedback', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}
