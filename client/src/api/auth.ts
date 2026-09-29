import client from './client';

export const getOAuthProviders = (): Promise<{ providers: string[] }> =>
  client.get('/auth/providers').then((r) => r.data);
