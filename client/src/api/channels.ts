import client from './client';
import type { Channel } from '../types';

export const getChannels = (): Promise<Channel[]> => client.get('/channels').then((r) => r.data);
