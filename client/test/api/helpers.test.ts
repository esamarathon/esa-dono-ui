import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  default: { get: mocks.get, post: mocks.post },
}));

import { getOAuthProviders } from '../../src/api/auth';
import { getCampaign } from '../../src/api/campaign';
import { getChannels } from '../../src/api/channels';
import { getDonor, requestToken } from '../../src/api/donor';
import { getGoals } from '../../src/api/goals';
import { getPolls } from '../../src/api/polls';
import { getRewards } from '../../src/api/rewards';
import { createPledge, getPledge } from '../../src/api/pledge';
import { getAuctions, getAuction, placeBid } from '../../src/api/auctions';

describe('public API helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getOAuthProviders returns the providers payload', async () => {
    mocks.get.mockResolvedValue({ data: { providers: ['google'] } });
    await expect(getOAuthProviders()).resolves.toEqual({ providers: ['google'] });
    expect(mocks.get).toHaveBeenCalledWith('/auth/providers');
  });

  it('getCampaign returns the campaign payload', async () => {
    mocks.get.mockResolvedValue({ data: { name: 'x' } });
    await expect(getCampaign()).resolves.toEqual({ name: 'x' });
    expect(mocks.get).toHaveBeenCalledWith('/campaign');
  });

  it('getChannels returns the channels array', async () => {
    mocks.get.mockResolvedValue({ data: [{ id: 'c1' }] });
    await expect(getChannels()).resolves.toEqual([{ id: 'c1' }]);
    expect(mocks.get).toHaveBeenCalledWith('/channels');
  });

  it('getDonor returns the wallet payload', async () => {
    mocks.get.mockResolvedValue({ data: { email: 'a@b.c' } });
    await expect(getDonor()).resolves.toEqual({ email: 'a@b.c' });
    expect(mocks.get).toHaveBeenCalledWith('/donor');
  });

  it('requestToken posts the email', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(requestToken('a@b.c')).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/auth/request-token', { email: 'a@b.c' });
  });

  it('getGoals returns the goals array', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    await expect(getGoals()).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith('/goals');
  });

  it('getPolls returns the polls array', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    await expect(getPolls()).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith('/polls');
  });

  it('getRewards returns the rewards array', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    await expect(getRewards()).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith('/rewards');
  });

  it('createPledge posts the cart items', async () => {
    mocks.post.mockResolvedValue({ data: { pledge_token: 'tok', total_cents: 1000 } });
    const input = {
      email: 'a@b.com',
      channel_id: 'c1',
      items: [{ kind: 'REWARD' as const, target_id: 'r1', amount_cents: 1000 }],
    };
    await expect(createPledge(input)).resolves.toEqual({ pledge_token: 'tok', total_cents: 1000 });
    expect(mocks.post).toHaveBeenCalledWith('/pledge', input);
  });

  it('getPledge returns the pledge status', async () => {
    mocks.get.mockResolvedValue({ data: { status: 'OPEN', total_cents: 500 } });
    await expect(getPledge('tok123')).resolves.toEqual({ status: 'OPEN', total_cents: 500 });
    expect(mocks.get).toHaveBeenCalledWith('/pledge/tok123');
  });

  it('getAuctions returns the auctions array with no params by default', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    await expect(getAuctions()).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith('/auctions', { params: {} });
  });

  it('getAuctions passes channel_id as a query param when provided', async () => {
    mocks.get.mockResolvedValue({ data: [{ id: 'a1' }] });
    await expect(getAuctions('c1')).resolves.toEqual([{ id: 'a1' }]);
    expect(mocks.get).toHaveBeenCalledWith('/auctions', { params: { channel_id: 'c1' } });
  });

  it('getAuction returns a single auction by id', async () => {
    mocks.get.mockResolvedValue({ data: { id: 'a1', title: 'Guitar' } });
    await expect(getAuction('a1')).resolves.toEqual({ id: 'a1', title: 'Guitar' });
    expect(mocks.get).toHaveBeenCalledWith('/auctions/a1');
  });

  it('placeBid posts the bid amount', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(placeBid('a1', 1500)).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/auctions/a1/bid', { amount_cents: 1500 });
  });
});
