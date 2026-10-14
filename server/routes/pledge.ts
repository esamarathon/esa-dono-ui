import { Router, type Request, type Response } from 'express';
import {
  createPledge,
  createCheckoutForPledge,
  pledgeResponse,
  type WalletDonor,
} from '../services/pledge.js';
import { resolveDonorToken } from '../middleware/donorAuth.js';
import prisma from '../lib/prisma.js';
import type { PledgePlan } from '@dono/shared';

const router = Router();

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
    let walletDonor: WalletDonor | null = null;
    const token = resolveDonorToken(req);
    if (token) {
      const donor = await prisma.donor.findUnique({ where: { magic_token: token } });
      if (
        donor &&
        donor.token_expires_at &&
        new Date() <= donor.token_expires_at &&
        !donor.is_frozen
      )
        walletDonor = donor;
    }
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
      walletDonorId: walletDonor?.id,
    });
    let checkout: { donate_url: string | null; checkout_session_id: string | null } = {
      donate_url: null,
      checkout_session_id: null,
    };
    try {
      checkout = await createCheckoutForPledge(pledge.pledge_token, walletDonor, email);
    } catch (checkoutErr) {
      // The confirmed Pending pledge/hold survives an unavailable external adapter.
      // Slice 3 owns Stripe reconciliation and recovery, not this plan comparison.
      console.error('Checkout session creation failed (non-fatal):', checkoutErr);
    }
    res.json({
      ...pledge,
      donate_url: checkout.donate_url,
      has_checkout: !!checkout.checkout_session_id,
    });
  } catch (err) {
    const error = err as Error & { status?: number; plan?: PledgePlan; items?: unknown };
    res
      .status(error.status || 500)
      .json({
        error: error.message,
        ...(error.plan ? { plan: error.plan, items: error.items } : {}),
      });
  }
});

/** Historical pledges are readable only, with an explicit LEGACY discriminant. */
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const pledge = await prisma.pendingPledge.findUnique({
      where: { pledge_token: req.params.token },
      include: { items: true },
    });
    if (!pledge) return res.status(404).json({ error: 'Pledge not found' });
    res.json(pledgeResponse(pledge));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
