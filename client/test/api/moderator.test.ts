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

interface RequestConfig {
  params: Record<string, unknown>;
  headers: Record<string, unknown>;
}

function getInterceptor(instance: {
  interceptors: { request: { use: ReturnType<typeof vi.fn> } };
}) {
  return instance.interceptors.request.use.mock.calls[0][0] as (
    config: RequestConfig,
  ) => RequestConfig;
}

describe('Moderator API client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  it('creates an axios instance with /api/moderator base URL', async () => {
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    expect(axios.create).toHaveBeenCalledWith({ baseURL: '/api/moderator' });
  });

  it('attaches ?token from localStorage donor_token', async () => {
    localStorage.setItem('donor_token', 'tok-123');
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.params.token).toBe('tok-123');
  });

  it('attaches X-Moderator-Key header from localStorage moderator_key', async () => {
    localStorage.setItem('moderator_key', 'mod-key-abc');
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.headers['X-Moderator-Key']).toBe('mod-key-abc');
  });

  it('omits X-Moderator-Key header when not set', async () => {
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.headers['X-Moderator-Key']).toBeUndefined();
  });
});
