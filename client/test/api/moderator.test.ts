import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosInstance } from 'axios';

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

function getInterceptor(instance: AxiosInstance) {
  const use = vi.mocked(instance.interceptors.request.use);
  const [onFulfilled] = use.mock.calls[0]!;
  return onFulfilled as unknown as (config: RequestConfig) => RequestConfig;
}

describe('Moderator API client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  it('creates an axios instance with /api/moderator base URL and withCredentials', async () => {
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: '/api/moderator',
      withCredentials: true,
    });
  });

  it('attaches the moderator key as a prefixed Bearer header when set', async () => {
    localStorage.setItem('moderator_key', 'mod-key-abc');
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.headers.Authorization).toBe('Bearer key_mod_mod-key-abc');
  });

  it('still sends the moderator key even when a donor session is active (server checks the key first)', async () => {
    localStorage.setItem('moderator_key', 'mod-key-abc');
    localStorage.setItem('donor_session_active', '1');
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.headers.Authorization).toBe('Bearer key_mod_mod-key-abc');
  });

  it('omits the Authorization header when nothing is set', async () => {
    await import('../../src/api/moderator');
    const axios = (await import('axios')).default;
    const instance = axios.create();
    const interceptor = getInterceptor(instance);
    const config = interceptor({ params: {}, headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });
});
