import nodemailer from 'nodemailer';

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
    })
  : null;

export async function sendMagicLink(email: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
  // Magic links land on the server, which sets an httpOnly session cookie and
  // redirects to the wallet — the token never reaches the SPA URL (ADR 0004).
  const url = `${baseUrl}/api/auth/magic?token=${token}`;

  if (!transporter) {
    console.log(`Magic link for ${email}: ${url}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'Donation Platform <no-reply@example.com>',
    to: email,
    subject: 'Your Donation Wallet Link',
    html: `
      <h2>Thank you for your donation!</h2>
      <p>Click the link below to access your wallet and spend your balance on rewards, polls, and goals:</p>
      <p><a href="${url}">${url}</a></p>
      <p>This link is valid for 30 days.</p>
    `,
  });
}

/**
 * Notify a bidder that they are the current offer-holder on a silent
 * auction: they have a fixed window to pay via the given Stripe Checkout
 * URL before the offer expires and cascades to the next-highest bidder.
 * Also used to resend the same offer on demand (identical copy).
 */
export async function sendAuctionOfferEmail(params: {
  email: string;
  auctionTitle: string;
  amountCents: number;
  checkoutUrl: string;
  expiresAt: Date;
}): Promise<void> {
  const { email, auctionTitle, amountCents, checkoutUrl, expiresAt } = params;
  const amount = (amountCents / 100).toFixed(2);
  const deadline = expiresAt.toUTCString();

  if (!transporter) {
    console.log(
      `Auction offer for ${email} — "${auctionTitle}" ($${amount}), pay by ${deadline}: ${checkoutUrl}`,
    );
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'Donation Platform <no-reply@example.com>',
    to: email,
    subject: `You're the winning bidder on "${auctionTitle}" — pay within 24 hours`,
    html: `
      <h2>You're currently the winning bidder!</h2>
      <p>Your bid of <strong>$${amount}</strong> on <strong>${auctionTitle}</strong> is the highest offer.</p>
      <p>You have <strong>24 hours</strong> (until ${deadline}) to complete payment. If payment isn't
      received by then, this offer expires and the item goes to the next highest bidder.</p>
      <p><a href="${checkoutUrl}">Complete your payment</a></p>
    `,
  });
}
