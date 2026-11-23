import client from './client';
import type { Schedule } from '../types';

/**
 * GET /api/schedule for the "Live / Up next" strip (#148) and its donation
 * acknowledgements (#250). The server computes the result from the Channel's
 * Horaro timetable and the Event's recent donations; the browser never calls
 * Horaro directly. `channelSlug` is the Channel in context; when omitted the
 * server falls back to the single active Event's primary Channel.
 */
export const getSchedule = (channelSlug?: string): Promise<Schedule> =>
  client
    .get('/schedule', { params: channelSlug ? { channel: channelSlug } : {} })
    .then((r) => r.data);
