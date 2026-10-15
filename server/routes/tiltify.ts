import { Router, type Request } from 'express';
import { handle } from '../lib/httpError.js';
import {
  getCampaign,
  getPoll,
  listMilestonesOrMatches,
  listPolls,
  listRewards,
  listTargets,
  lookupPoll,
  lookupReward,
  lookupTarget,
} from '../services/tiltifyApi.js';

/**
 * Tiltify-compatible read API (PRD-0002 §R, ADR-0010), mounted at /api/tiltify.
 * Public and read-only like /donate; the global API limit applies. Consumers point their
 * bridge URL at `<APP_BASE_URL>/api/tiltify/` (trailing slash: kollekt resolves
 * relative paths against it).
 *
 * `limit`/`after`/`before` are accepted and ignored: every list is one page.
 */
const router = Router();

function serve(read: (campaignId: string, req: Request) => Promise<unknown>) {
  return handle('[tiltify]', async (req, res) => {
    res.json(await read(String(req.params.id), req));
  });
}

router.get('/campaigns/:id', serve(getCampaign));
router.get('/campaign/:id/rewards', serve(listRewards));
router.get(
  '/campaign/:id/lookup/rewards/:reward_id',
  serve((campaignId, req) => lookupReward(campaignId, String(req.params.reward_id))),
);
router.get('/campaign/:id/targets', serve(listTargets));
router.get(
  '/campaign/:id/lookup/targets/:target_id',
  serve((campaignId, req) => lookupTarget(campaignId, String(req.params.target_id))),
);
router.get('/campaign/:id/polls', serve(listPolls));
router.get(
  '/campaign/:id/lookup/polls/:poll_id',
  serve((campaignId, req) => lookupPoll(campaignId, String(req.params.poll_id))),
);
router.get(
  '/campaign/:id/polls/:poll_id',
  serve((campaignId, req) => getPoll(campaignId, String(req.params.poll_id))),
);
router.get('/campaign/:id/milestones', serve(listMilestonesOrMatches));
router.get('/campaign/:id/matches', serve(listMilestonesOrMatches));

export default router;
