import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/tiltify.js', () => ({
  getCampaign: vi.fn(),
}));

import { getCampaign } from '../../services/tiltify.js';
import campaignRouter from '../../routes/campaign.js';

function createApp() {
  const app = express();
  app.use('/api/campaign', campaignRouter);
  return app;
}

describe('GET /api/campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TILTIFY_CLIENT_ID = '';
  });

  it('returns stub campaign when TILTIFY_CLIENT_ID is not set', async () => {
    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('ESA Charity Marathon');
    expect(res.body.description).toBeDefined();
    expect(res.body.donate_url).toBeNull();
    expect(getCampaign).not.toHaveBeenCalled();
  });

  it('calls Tiltify API when client ID is set', async () => {
    process.env.TILTIFY_CLIENT_ID = 'test-client-id';
    const mockCampaign = { name: 'Real Campaign', amount_raised: { value: '100.00' } };
    vi.mocked(getCampaign).mockResolvedValue(mockCampaign as any);

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Real Campaign');
    expect(res.body.donate_url).toBeNull();
    expect(getCampaign).toHaveBeenCalled();
  });

  it('includes donate_url from env', async () => {
    process.env.TILTIFY_CLIENT_ID = 'test-client-id';
    process.env.TILTIFY_DONATE_URL = 'https://tiltify.com/donate/test';
    const mockCampaign = { name: 'Real Campaign' };
    vi.mocked(getCampaign).mockResolvedValue(mockCampaign as any);

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(200);
    expect(res.body.donate_url).toBe('https://tiltify.com/donate/test');
  });

  it('returns 500 when Tiltify API fails', async () => {
    process.env.TILTIFY_CLIENT_ID = 'test-client-id';
    vi.mocked(getCampaign).mockRejectedValue(new Error('API error'));

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch campaign');
  });
});
