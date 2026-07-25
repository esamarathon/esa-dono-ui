import client from './client';
import type { DonorWallet } from '../types';
export const getDonor = (): Promise<DonorWallet> => client.get('/donor').then((r) => r.data);
