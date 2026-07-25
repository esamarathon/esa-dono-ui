import { Router, type Request, type Response } from 'express';
import { createPledge, createRelayForPledge } from '../services/pledge.js';

const router = Router();

/**
 * POST /api/pledge
 * Create a pending pledge from cart items.
 * Body: { email?, items: [{ kind, target_id, amount_cents?, poll_id?, data? }] }
 * Returns: { pledge_token, total_cents, expires_at, donate_url }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { email, items } = req.body;
    const pledge = await createPledge({ email, items });

    // Create Tiltify relay key for deterministic linkage (graceful fallback)
    let relay: { donate_url: string | null; relay_client_key: string | null | undefined } = {
      donate_url: null,
      relay_client_key: null,
    };
    try {
      relay = await createRelayForPledge(pledge.pledge_token);
    } catch (relayErr) {
      console.error('Relay key creation failed (non-fatal):', relayErr);
    }

    res.json({
      ...pledge,
      donate_url: relay.donate_url,
      has_relay: !!relay.relay_client_key,
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
      include: { items: true },
    });
    if (!pledge) return res.status(404).json({ error: 'Pledge not found' });
    res.json({
      pledge_token: pledge.pledge_token,
      total_cents: pledge.total_cents,
      status: pledge.status,
      donor_email: pledge.donor_email,
      expires_at: pledge.expires_at,
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
