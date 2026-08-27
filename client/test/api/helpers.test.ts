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
});
