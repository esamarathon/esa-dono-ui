import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('axios', () => {
  const instance = {
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn() } },
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    patch: mocks.patch,
    delete: mocks.delete,
  };
  return { default: { create: vi.fn(() => instance) } };
});

import {
  getDonors,
  createDonor,
  getDonorWallet,
  revokeDonorToken,
  regenerateDonorToken,
  toggleDonorFreeze,
  setDonorRole,
  adjustDonorBalance,
  reverseDonorSpend,
  refundPollOption,
  refundGoal,
  getClaims,
  updateClaimStatus,
  getDestinations,
  createDestination,
  updateDestination,
  rotateDestinationSecret,
  deleteDestination,
  getDestinationDeliveries,
  testDestination,
  uploadRewardImage,
} from '../../src/api/admin';

describe('admin API helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getDonors returns the { donors, total } payload', async () => {
    mocks.get.mockResolvedValue({ data: { donors: [], total: 0 } });
    await expect(getDonors('q', 10)).resolves.toEqual({ donors: [], total: 0 });
    expect(mocks.get).toHaveBeenCalledWith('/donors', { params: { q: 'q', offset: 10 } });
  });

  it('createDonor posts a donor', async () => {
    mocks.post.mockResolvedValue({ data: { id: 'd1' } });
    await expect(createDonor('a@b.c', 'MODERATOR')).resolves.toEqual({ id: 'd1' });
    expect(mocks.post).toHaveBeenCalledWith('/donors', { email: 'a@b.c', role: 'MODERATOR' });
  });

  it('getDonorWallet returns the wallet payload', async () => {
    mocks.get.mockResolvedValue({ data: { id: 'd1' } });
    await expect(getDonorWallet('d1')).resolves.toEqual({ id: 'd1' });
    expect(mocks.get).toHaveBeenCalledWith('/donors/d1');
  });

  it('revokeDonorToken posts to the revoke endpoint', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(revokeDonorToken('d1')).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/donors/d1/revoke-token');
  });

  it('regenerateDonorToken returns the magic token', async () => {
    mocks.post.mockResolvedValue({ data: { magic_token: 'tok', email: 'a@b.c' } });
    await expect(regenerateDonorToken('d1')).resolves.toEqual({
      magic_token: 'tok',
      email: 'a@b.c',
    });
  });

  it('toggleDonorFreeze posts the frozen flag', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(toggleDonorFreeze('d1', true)).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/donors/d1/freeze', { frozen: true });
  });

  it('setDonorRole patches the role', async () => {
    mocks.patch.mockResolvedValue({ data: { success: true } });
    await expect(setDonorRole('d1', 'ADMIN')).resolves.toEqual({ success: true });
    expect(mocks.patch).toHaveBeenCalledWith('/donors/d1/role', { role: 'ADMIN' });
  });

  it('adjustDonorBalance posts the adjustment', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(adjustDonorBalance('d1', 100, 'r', 'MANUAL')).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/donors/d1/adjust-balance', {
      amount_cents: 100,
      reason: 'r',
      type: 'MANUAL',
    });
  });

  it('reverseDonorSpend posts the reversal', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    await expect(reverseDonorSpend('d1', 'vote', 'v1')).resolves.toEqual({ success: true });
    expect(mocks.post).toHaveBeenCalledWith('/donors/d1/reverse-spend', {
      spend_type: 'vote',
      spend_id: 'v1',
    });
  });

  it('refundPollOption and refundGoal hit the refund endpoints', async () => {
    mocks.post.mockResolvedValue({ data: { refunded_count: 1 } });
    await expect(refundPollOption('o1')).resolves.toEqual({ refunded_count: 1 });
    expect(mocks.post).toHaveBeenCalledWith('/polls/options/o1/refund');
    await expect(refundGoal('g1')).resolves.toEqual({ refunded_count: 1 });
    expect(mocks.post).toHaveBeenCalledWith('/goals/g1/refund');
  });

  it('getClaims and updateClaimStatus work', async () => {
    mocks.get.mockResolvedValue({ data: [{ id: 'c1' }] });
    await expect(getClaims()).resolves.toEqual([{ id: 'c1' }]);
    expect(mocks.get).toHaveBeenCalledWith('/claims');
    mocks.patch.mockResolvedValue({ data: { id: 'c1', status: 'FULFILLED' } });
    await expect(updateClaimStatus('c1', 'FULFILLED')).resolves.toEqual({
      id: 'c1',
      status: 'FULFILLED',
    });
    expect(mocks.patch).toHaveBeenCalledWith('/claims/c1', { status: 'FULFILLED' });
  });

  it('getDestinations returns the endpoint array', async () => {
    mocks.get.mockResolvedValue({ data: [{ id: 'e1' }] });
    await expect(getDestinations()).resolves.toEqual([{ id: 'e1' }]);
    expect(mocks.get).toHaveBeenCalledWith('/destinations');
  });

  it('createDestination posts the payload', async () => {
    mocks.post.mockResolvedValue({ data: { id: 'e1' } });
    await expect(
      createDestination({ url: 'https://x', event_types: ['donation.created'] }),
    ).resolves.toEqual({ id: 'e1' });
    expect(mocks.post).toHaveBeenCalled();
  });

  it('updateDestination puts the payload', async () => {
    mocks.put.mockResolvedValue({ data: { id: 'e1' } });
    await expect(updateDestination('e1', { is_active: false })).resolves.toEqual({ id: 'e1' });
    expect(mocks.put).toHaveBeenCalledWith('/destinations/e1', { is_active: false });
  });

  it('rotateDestinationSecret, deleteDestination, getDestinationDeliveries, testDestination work', async () => {
    mocks.post.mockResolvedValue({ data: { id: 'e1' } });
    await expect(rotateDestinationSecret('e1')).resolves.toEqual({ id: 'e1' });
    expect(mocks.post).toHaveBeenCalledWith('/destinations/e1/rotate-secret');

    mocks.delete.mockResolvedValue({ data: { success: true } });
    await expect(deleteDestination('e1')).resolves.toEqual({ success: true });
    expect(mocks.delete).toHaveBeenCalledWith('/destinations/e1');

    mocks.get.mockResolvedValue({ data: { deliveries: [], total: 0 } });
    await expect(getDestinationDeliveries('e1')).resolves.toEqual({ deliveries: [], total: 0 });
    expect(mocks.get).toHaveBeenCalledWith('/destinations/e1/deliveries', {
      params: { limit: 50, offset: 0 },
    });

    mocks.post.mockResolvedValue({ data: { success: true, seq: 1 } });
    await expect(testDestination('e1')).resolves.toEqual({ success: true, seq: 1 });
    expect(mocks.post).toHaveBeenCalledWith('/destinations/e1/test');
  });

  it('uploadRewardImage posts multipart form data and returns the url', async () => {
    mocks.post.mockResolvedValue({ data: { url: '/api/uploads/x.webp' } });
    await expect(uploadRewardImage(new File(['x'], 'x.png'))).resolves.toBe('/api/uploads/x.webp');
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/moderator/uploads',
      expect.any(FormData),
      expect.objectContaining({ baseURL: '/' }),
    );
  });
});
