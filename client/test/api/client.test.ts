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

describe('API client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get fresh module with cleared mocks
    vi.resetModules();
  });

  it('creates an axios instance with /api base URL', async () => {
    await import('../../src/api/client');
    const axios = (await import('axios')).default;
    expect(axios.create).toHaveBeenCalledWith({ baseURL: '/api' });
  });

  it('registers a request interceptor', async () => {
    await import('../../src/api/client');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    expect(instance.interceptors.request.use).toHaveBeenCalled();
  });
});
