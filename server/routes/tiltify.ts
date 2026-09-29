import { Router, type Request, type Response } from 'express';
import { sendError } from '../lib/httpError.js';
import { tiltifyLimit } from '../middleware/rateLimit.js';
import {
  getCampaign,
  getPoll,
  listNone,
  listPolls,
  listRewards,
  listTargets,
} from '../services/tiltifyApi.js';

/**
 * Tiltify-compatible read API (PRD-0002 §R, ADR-0010), mounted at /api/tiltify.
 * Public and read-only like /donate; rate-limited per IP. Consumers point their
 * bridge URL at `<APP_BASE_URL>/api/tiltify/` (trailing slash: kollekt resolves
 * relative paths against it).
 *
 * `limit`/`after`/`before` are accepted and ignored: every list is one page.
 */
const router = Router();
router.use(tiltifyLimit);

/** Send `value`, or 404 when the service returned null (unknown id). */
function reply(res: Response, value: unknown) {
  if (value === null) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(value);
}

function route(read: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      reply(res, await read(req));
    } catch (e) {
      sendError(res, e, '[tiltify]');
    }
  };
}

const id = (req: Request) => String(req.params.id);

router.get(
  '/campaigns/:id',
  route((req) => getCampaign(id(req))),
);
router.get(
  '/campaign/:id/rewards',
  route((req) => listRewards(id(req))),
);
router.get(
  '/campaign/:id/targets',
  route((req) => listTargets(id(req))),
);
router.get(
  '/campaign/:id/polls',
  route((req) => listPolls(id(req))),
);
router.get(
  '/campaign/:id/polls/:poll_id',
  route((req) => getPoll(id(req), String(req.params.poll_id))),
);
router.get(
  '/campaign/:id/milestones',
  route((req) => listNone(id(req))),
);
router.get(
  '/campaign/:id/matches',
  route((req) => listNone(id(req))),
);

export default router;
