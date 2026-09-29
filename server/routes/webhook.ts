import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';

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
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.expired') {
      return res.status(200).json({ received: true });
    }

    const session = event.data?.object as
      | {
          id?: string;
          amount_total?: number | null;
          customer_details?: { email?: string | null; name?: string | null } | null;
          customer_email?: string | null;
          metadata?: Record<string, string> | null;
          client_reference_id?: string | null;
          total_details?: { amount_shipping?: number | null } | null;
        }
      | undefined;

    if (!session) {
      return res.status(200).json({ received: true, skipped: 'no session object' });
    }

    const auctionId = session.metadata?.auction_id ?? null;
    if (auctionId && session.id) {
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

    if (event.type !== 'checkout.session.completed') {
      // checkout.session.expired for a non-auction (pledge) session — no
      // action needed, pledges simply remain OPEN until their own TTL.
      return res.status(200).json({ received: true });
    }

    const externalId = session.id;
    const pledgeToken = session.metadata?.pledge_token ?? session.client_reference_id ?? null;
    const email = session.customer_details?.email ?? session.customer_email;
    const donorName = session.customer_details?.name ?? 'Anonymous';
    const amountCents = session.amount_total ?? 0;
    const shippingCents = session.total_details?.amount_shipping ?? 0;

    if (!email || !externalId) {
      return res.status(200).json({ received: true, skipped: 'missing email or id' });
    }

    // Delegate to shared donation processor. Comment is sourced from the resolved
    // pledge (donor captured it in the cart), so none is passed here.
    const { processDonation } = await import('../services/donation.js');
    await processDonation({
      externalId,
      email,
      donorName,
      amountCents,
      comment: null,
      pledgeToken,
      shippingCents,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
