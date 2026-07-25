import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { amountToCents, type TiltifyWebhookPayload } from '@dono/shared';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-tiltify-signature'];
    const timestamp = req.headers['x-tiltify-timestamp'];
    const rawBody = req.body as Buffer; // Buffer from express.raw()

    if (process.env.TILTIFY_WEBHOOK_SECRET) {
      if (!signature || !timestamp) {
        return res.status(400).json({ error: 'Missing signature headers' });
      }
      const message = timestamp + '.' + rawBody.toString();
      const expectedSig = crypto
        .createHmac('sha256', process.env.TILTIFY_WEBHOOK_SECRET)
        .update(message)
        .digest('hex');
      const sigBuffer = Buffer.from(signature as string);
      const expectedBuffer = Buffer.from(expectedSig);
      if (
        sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload = JSON.parse(rawBody.toString()) as TiltifyWebhookPayload;
    const meta = payload.meta ?? {};
    const eventType = meta.event_type ?? payload.type ?? '';

    // Handle relay events (private:relay:donation_updated)
    const isRelay = eventType.includes('relay');
    const isDonationEvent =
      eventType.includes('donation_updated') || eventType === 'donation.completed';

    if (!isDonationEvent) {
      return res.status(200).json({ received: true });
    }

    const donation = payload.data ?? payload.donation ?? {};
    const tiltifyId = donation.id?.toString() ?? donation.legacy_id?.toString();
    const email = donation.donor_email ?? donation.campaign_donation?.donor?.email;
    const donorName = donation.donor_name ?? donation.campaign_donation?.donor?.name ?? 'Anonymous';
    const rawAmount =
      typeof donation.amount === 'object' && donation.amount !== null
        ? donation.amount.value
        : donation.amount;
    const amountCents = amountToCents(rawAmount ?? 0);
    const comment = donation.comment ?? donation.campaign_donation?.comment ?? null;

    // For relay events, extract the pledge token from relay_key_id
    let pledgeToken: string | null = null;
    if (isRelay && meta.relay_key_id) {
      const pledgePrefix = 'pledge_';
      if (meta.relay_key_id.startsWith(pledgePrefix)) {
        pledgeToken = meta.relay_key_id.slice(pledgePrefix.length);
      }
    }

    // For relay events, only process completed payments
    if (isRelay && donation.payment_status && donation.payment_status !== 'completed') {
      return res.status(200).json({ received: true, status: donation.payment_status });
    }

    if (!email || !tiltifyId) {
      return res.status(200).json({ received: true, skipped: 'missing email or id' });
    }

    // Delegate to shared donation processor
    const { processDonation } = await import('../services/donation.js');
    await processDonation({
      tiltifyId,
      email,
      donorName,
      amountCents,
      comment,
      pledgeToken,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
