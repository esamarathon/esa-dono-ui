import client from './client';
import type { DonorWallet } from '../types';
export const getDonor = (): Promise<DonorWallet> => client.get('/donor').then((r) => r.data);

export const requestToken = (email: string): Promise<{ success: boolean }> =>
  client.post('/auth/request-token', { email }).then((r) => r.data);
