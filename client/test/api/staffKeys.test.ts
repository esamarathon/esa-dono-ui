import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('axios', () => ({ default: { get: mocks.get } }));

import { validateAdminKey, validateModeratorKey } from '../../src/api/staffKeys';

describe('staff key validation probes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ data: {} });
  });

  it('accepts an admin key when the admin stats endpoint responds successfully', async () => {
    await expect(validateAdminKey('good')).resolves.toBe('valid');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/stats', {
      headers: { Authorization: 'Bearer key_admin_good' },
      withCredentials: false,
      timeout: 10_000,
    });
  });

  it('sends the moderator key with the key_mod_ prefix to moderator stats', async () => {
    await expect(validateModeratorKey('good')).resolves.toBe('valid');
    expect(mocks.get).toHaveBeenCalledWith('/api/moderator/stats', {
      headers: { Authorization: 'Bearer key_mod_good' },
      withCredentials: false,
      timeout: 10_000,
    });
  });

  it('maps 401 and 403 responses to invalid', async () => {
    mocks.get.mockRejectedValue({ response: { status: 401 } });
    await expect(validateAdminKey('bad')).resolves.toBe('invalid');
    mocks.get.mockRejectedValue({ response: { status: 403 } });
    await expect(validateModeratorKey('bad')).resolves.toBe('invalid');
  });

  it('maps network failures and 5xx responses to unavailable', async () => {
    mocks.get.mockRejectedValue(new Error('network down'));
    await expect(validateAdminKey('x')).resolves.toBe('unavailable');
    mocks.get.mockRejectedValue({ response: { status: 500 } });
    await expect(validateModeratorKey('x')).resolves.toBe('unavailable');
    mocks.get.mockRejectedValue({ response: { status: 404 } });
    await expect(validateAdminKey('x')).resolves.toBe('unavailable');
  });
});
