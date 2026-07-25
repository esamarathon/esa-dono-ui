import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => {
  const interceptors = { request: { use: vi.fn() } };
  const instance = {
    defaults: { headers: { common: {} } },
    interceptors,
  };
  const create = vi.fn(() => instance);
  return { default: { create } };
});

describe('Admin API client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('creates an axios instance with /api/admin base URL', async () => {
    await import('../../src/api/admin');
    const axios = (await import('axios')).default;
    expect(axios.create).toHaveBeenCalledWith({ baseURL: '/api/admin' });
  });

  it('registers a request interceptor', async () => {
    await import('../../src/api/admin');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    expect(instance.interceptors.request.use).toHaveBeenCalled();
  });
});
