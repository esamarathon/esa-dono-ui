import type { Router } from 'express';
import prisma from '../lib/prisma.js';
import { handle } from '../lib/httpError.js';
import { createChannel, deactivateChannel, updateChannel } from '../services/channels.js';
import { createEvent, deactivateEvent, updateEvent } from '../services/events.js';

/**
 * Channel and Event management (ADR-0008, PRD-0002 §E1), identical for admins
 * and moderators, so both routers mount the same handlers. Delete deactivates:
 * incentives, donations and pledges reference Channels and Events.
 */
export function mountIdentityRoutes(router: Router): void {
  router.get(
    '/channels',
    handle('[channels]', async (_req, res) => {
      res.json(await prisma.channel.findMany({ orderBy: { created_at: 'asc' } }));
    }),
  );
  router.post(
    '/channels',
    handle('[channels]', async (req, res) => {
      res.json(await createChannel(req.body ?? {}));
    }),
  );
  router.put(
    '/channels/:id',
    handle('[channels]', async (req, res) => {
      res.json(await updateChannel(req.params.id!, req.body ?? {}));
    }),
  );
  router.delete(
    '/channels/:id',
    handle('[channels]', async (req, res) => {
      res.json({ success: true, channel: await deactivateChannel(req.params.id!) });
    }),
  );

  router.get(
    '/events',
    handle('[events]', async (_req, res) => {
      res.json(await prisma.event.findMany({ orderBy: { created_at: 'asc' } }));
    }),
  );
  router.post(
    '/events',
    handle('[events]', async (req, res) => {
      res.json(await createEvent(req.body ?? {}));
    }),
  );
  router.put(
    '/events/:id',
    handle('[events]', async (req, res) => {
      res.json(await updateEvent(req.params.id!, req.body ?? {}));
    }),
  );
  router.delete(
    '/events/:id',
    handle('[events]', async (req, res) => {
      res.json({ success: true, event: await deactivateEvent(req.params.id!) });
    }),
  );
}
