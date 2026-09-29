import client from './client';
import type { PublicEvent } from '../types';

/** Active events (with their active channels), for the /donate event picker. */
export const getPublicEvents = (): Promise<PublicEvent[]> =>
  client.get('/events').then((r) => r.data);

/** One active event by slug, for /donate/<event-slug>[/<channel-slug>] (#115). */
export const getPublicEvent = (slug: string): Promise<PublicEvent> =>
  client.get(`/events/${slug}`).then((r) => r.data);
