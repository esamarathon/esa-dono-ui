import client from './client';
import type { Campaign } from '../types';
export const getCampaign = (): Promise<Campaign> => client.get('/campaign').then((r) => r.data);
