import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { reconcileCheckoutNotification, type CheckoutNotification } from '../services/checkout.js';
import type { CheckoutSession } from '../services/stripe.js';
import { recordLegacyAsyncFailureTx } from '../services/reversal.js';
import { withWebhooks } from '../services/webhooks/outbox.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer; // Buffer from express.raw()
  const { verifyWebhook } = await import('../services/stripe.js');

  let event: Stripe.Event;
  try {
    event = await verifyWebhook(rawBody, req.headers['stripe-signature']);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    console.error('Webhook verification error:', err);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (
      ![
        'checkout.session.completed',
        'checkout.session.expired',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
      ].includes(event.type)
    ) {
      return res.status(200).json({ received: true });
    }

    const session = event.data?.object as CheckoutSession | undefined;

    if (!session?.id) {
      return res.status(200).json({ received: true, skipped: 'no session object' });
    }

    const auctionId = session.metadata?.auction_id ?? null;
    if (auctionId && session.id) {
      // Auctions retain their own completed/expired lifecycle, not pledge holds.
      if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.expired')
        return res.status(200).json({ received: true });
      const prisma = (await import('../lib/prisma.js')).default;
      if (event.type === 'checkout.session.expired') {
        const { advanceCascadeTx } = await import('../services/auction.js');
        const sessionId = session.id;
        await prisma.$transaction((tx) => advanceCascadeTx(tx, auctionId, sessionId));
      } else {
        const { settleWinTx } = await import('../services/auction.js');
        const sessionId = session.id;
        await prisma.$transaction((tx) => settleWinTx(tx, auctionId, sessionId));
      }
      return res.status(200).json({ received: true });
    }

    const result = await reconcileCheckoutNotification(event.type as CheckoutNotification, session);
    if (result && 'legacy_async_failure' in result) {
      await withWebhooks((tx, _emit, publisher) =>
        recordLegacyAsyncFailureTx(tx, result.legacy_async_failure, publisher),
      );
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
