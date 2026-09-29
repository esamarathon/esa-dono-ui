import client from './client';
import type { Auction } from '../types';

export const getAuctions = (channelId?: string): Promise<Auction[]> =>
  client
    .get('/auctions', { params: channelId ? { channel_id: channelId } : {} })
    .then((r) => r.data);

export const getAuction = (id: string): Promise<Auction> =>
  client.get(`/auctions/${id}`).then((r) => r.data);

export const placeBid = (id: string, amountCents: number): Promise<{ success: true }> =>
  client.post(`/auctions/${id}/bid`, { amount_cents: amountCents }).then((r) => r.data);
