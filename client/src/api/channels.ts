import client from './client';
import type { Channel } from '../types';

export const getChannels = (): Promise<Channel[]> => client.get('/events').then((r) => r.data);
