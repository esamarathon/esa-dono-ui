import { Router, type Request, type Response } from 'express';
import {
  createPledge,
  createCheckoutForPledge,
  pledgeResponse,
  type WalletDonor,
} from '../services/pledge.js';
import { cancelPledge, getPledge, reconcilePledge } from '../services/checkout.js';
import { defaultGoalPreview } from '../services/defaultGoal.js';
import { resolveDonorToken } from '../middleware/donorAuth.js';
import { httpError } from '../lib/httpError.js';
import prisma from '../lib/prisma.js';
import type { PledgePlan } from '@dono/shared';

const router = Router();

async function walletDonor(req: Request): Promise<WalletDonor | null> {
  const token = resolveDonorToken(req);
  if (!token) return null;
  const donor = await prisma.donor.findUnique({ where: { magic_token: token } });
  return donor && donor.token_expires_at && new Date() <= donor.token_expires_at && !donor.is_frozen
    ? donor
    : null;
}

/** New drafts confirm a live plan; retrying a draft preserves its original funding. */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      email,
      comment,
      display_name,
      items,
      pledge_amount_cents,
      draft_id,
      plan,
      top_up_cents,
      channel_id,
    } = req.body;
    // Authentication precedes planning. Email alone never authorizes Wallet credit.
    const donor = await walletDonor(req);
    const pledge = await createPledge({
      email,
      comment,
      display_name,
      items,
      pledge_amount_cents,
      draft_id,
      plan,
      top_up_cents,
      channel_id,
      walletDonorId: donor?.id,
    });
    let checkoutError: string | null = null;
    let donateUrl: string | null = null;
    try {
      const stored = await getPledge(pledge.pledge_token);
      if (stored.checkout_session_id) await reconcilePledge(pledge.pledge_token);
      const checkout = await createCheckoutForPledge(pledge.pledge_token, donor);
      donateUrl = checkout.donate_url;
    } catch (error) {
      // The confirmed immutable pledge/hold survives an uncertain external call.
      checkoutError = (error as Error).message;
    }
    res.json({
      ...pledgeResponse(await getPledge(pledge.pledge_token)),
      ...(donateUrl ? { donate_url: donateUrl } : {}),
      checkout_error: checkoutError,
    });
  } catch (err) {
    const error = err as Error & { status?: number; plan?: PledgePlan; items?: unknown };
    res.status(error.status || 500).json({
      error: error.message,
      ...(error.plan ? { plan: error.plan, items: error.items } : {}),
    });
  }
});

/** Token possession permits reconciliation, never authentication or Wallet changes on a new plan. */
router.post('/:token/reconcile', async (req, res) => {
  try {
    res.json(await reconcilePledge(req.params.token));
  } catch (error) {
    await actionError(req, res, error);
  }
});
router.post('/:token/cancel', async (req, res) => {
  try {
    res.json(await cancelPledge(req.params.token, await walletDonor(req)));
  } catch (error) {
    await actionError(req, res, error);
  }
});
router.post('/:token/continue', async (req, res) => {
  try {
    const donor = await walletDonor(req);
    const pledge = await getPledge(req.params.token);
    if (pledge.format !== 'POOLED') throw httpError(409, 'Legacy pledges are read-only');
    if (pledge.wallet_donor_id && pledge.wallet_donor_id !== donor?.id)
      throw httpError(403, 'This pledge belongs to another donor session');
    if (pledge.checkout_session_id || pledge.checkout_requested_at)
      await reconcilePledge(req.params.token);
    const latest = await getPledge(req.params.token);
    if (
      latest.status === 'OPEN' &&
      !latest.non_payment_confirmed_at &&
      latest.checkout_session_status !== 'complete'
    )
      await createCheckoutForPledge(req.params.token, donor);
    res.json(pledgeResponse(await getPledge(req.params.token)));
  } catch (error) {
    await actionError(req, res, error);
  }
});

async function actionError(req: Request, res: Response, error: unknown) {
  const status = (error as { status?: number }).status || 409;
  // The UI can keep the confirmed review on uncertain payment, without leaking PII.
  const pledge = status === 409 ? pledgeResponse(await getPledge(req.params.token!)) : undefined;
  res.status(status).json({ error: (error as Error).message, ...(pledge ? { pledge } : {}) });
}

/** Live explanatory preview only; never reserves funding or creates a pledge. */
router.get('/default-goal/:channelId', async (req, res) => {
  try {
    res.json(await defaultGoalPreview(req.params.channelId));
  } catch (error) {
    res
      .status((error as { status?: number }).status || 500)
      .json({ error: (error as Error).message });
  }
});

/** Historical pledges are readable only, with an explicit LEGACY discriminant. */
router.get('/:token', async (req: Request, res: Response) => {
  try {
    res.json(pledgeResponse(await getPledge(req.params.token!)));
  } catch (error) {
    res
      .status((error as { status?: number }).status || 500)
      .json({ error: (error as Error).message });
  }
});

export default router;
