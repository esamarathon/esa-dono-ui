import { Router, type Request, type Response } from 'express';
import { createPledge, createCheckoutForPledge, type WalletDonor } from '../services/pledge.js';
import { resolveDonorToken } from '../middleware/donorAuth.js';

const router = Router();

/**
 * POST /api/pledge
 * Create a pending pledge from cart items.
 * Body: { email?, comment?, items: [{ kind, target_id, amount_cents?, poll_id?, data? }] }
 * Query: ?token=<magic_token> — when a valid donor token is provided, the donor's
 *         wallet balance is applied as a discount on the Stripe checkout amount.
 * Returns: { pledge_token, total_cents, expires_at, donate_url, has_checkout, wallet_discount_cents }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { email, comment, items, top_up_cents, channel_id } = req.body;
    const pledge = await createPledge({ email, comment, items, top_up_cents, channel_id });

    // Resolve authenticated donor from magic token (wallet discount) — optional.
    // Must be a valid, non-expired, non-frozen token. Wallet discount is only
    // applied for authenticated donors, never by email alone.
    let walletDonor: WalletDonor | null = null;
    const token = resolveDonorToken(req);
    if (token && typeof token === 'string') {
      const { default: prisma } = await import('../lib/prisma.js');
      const donor = await prisma.donor.findUnique({
        where: { magic_token: token },
        select: {
          id: true,
          email: true,
          balance_remaining: true,
          magic_token: true,
          token_expires_at: true,
          is_frozen: true,
        },
      });
      if (
        donor &&
        donor.token_expires_at &&
        new Date() <= donor.token_expires_at &&
        !donor.is_frozen
      ) {
        walletDonor = {
          id: donor.id,
          email: donor.email,
          balance_remaining: donor.balance_remaining,
          magic_token: donor.magic_token,
        };
      }
    }

    // Create Stripe Checkout Session for deterministic linkage (graceful fallback)
    let checkout: {
      donate_url: string | null;
      checkout_session_id: string | null;
      wallet_discount_cents?: number;
    } = {
      donate_url: null,
      checkout_session_id: null,
    };
    try {
      checkout = await createCheckoutForPledge(pledge.pledge_token, walletDonor, email);
    } catch (checkoutErr) {
      console.error('Checkout session creation failed (non-fatal):', checkoutErr);
    }

    res.json({
      ...pledge,
      donate_url: checkout.donate_url,
      has_checkout: !!checkout.checkout_session_id,
      wallet_discount_cents: checkout.wallet_discount_cents ?? 0,
    });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/pledge/:token
 * Get pledge status (for the return/confirmation page).
 */
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const { default: prisma } = await import('../lib/prisma.js');
    const pledge = await prisma.pendingPledge.findUnique({
      where: { pledge_token: req.params.token },
      include: { items: true, fulfilled_by: { include: { donor: true } } },
    });
    if (!pledge) return res.status(404).json({ error: 'Pledge not found' });
    res.json({
      pledge_token: pledge.pledge_token,
      total_cents: pledge.total_cents,
      top_up_cents: pledge.top_up_cents,
      status: pledge.status,
      donor_email: pledge.donor_email,
      expires_at: pledge.expires_at,
      magic_token:
        pledge.status === 'FULFILLED' ? (pledge.fulfilled_by?.donor?.magic_token ?? null) : null,
      items: pledge.items.map((i) => ({
        kind: i.kind,
        target_id: i.target_id,
        amount_cents: i.amount_cents,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
