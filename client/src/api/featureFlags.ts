import client from './client';

export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  const response = await client.get('/feature-flags');
  return response.data;
}
