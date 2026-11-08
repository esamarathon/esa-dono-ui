import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';

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

  const htmlUrl = url
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'ESA Donations <no-reply@example.com>',
    to: email,
    subject: 'Your Donation Wallet Link',
    text: `Thank you for your support!

View your donations, manage your incentive selections, and use available Wallet credit.

Open your wallet: ${url}

Your sign-in link is valid for 30 days.

This link signs you in. Keep it private and do not forward this email.`,
    html: `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="color-scheme" content="dark">
        <title>Your Donation Wallet Link</title>
      </head>
      <body style="margin:0;padding:0;background-color:#191919;color:#efeeec;font-family:Arial,Helvetica,sans-serif">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Thank you for your support! Open your ESA donation wallet.</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#191919">
          <tr><td align="center" style="padding:24px 12px">
            <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;text-align:left;font-family:Arial,Helvetica,sans-serif">
              <tr><td style="padding:0 20px 20px">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td style="padding-right:12px"><img src="cid:esa-emblem" width="48" height="48" alt="ESA" style="display:block;border:0"></td>
                  <td style="font-size:15px;line-height:22px;letter-spacing:2px;font-weight:bold;color:#efeeec">ESA<br><span style="font-size:11px;letter-spacing:1.6px;color:#c6c1cc">DONOR WALLET</span></td>
                </tr></table>
              </td></tr>
              <tr><td height="4" bgcolor="#734e9e" style="font-size:0;line-height:4px;background-color:#734e9e;background-image:linear-gradient(90deg,#734e9e,#d09846)">&nbsp;</td></tr>
              <tr><td bgcolor="#242127" style="padding:30px 24px;border:1px solid #3a343e;border-top:0;border-radius:0 0 8px 8px">
                <p style="margin:0 0 12px;font-size:11px;line-height:16px;letter-spacing:2px;font-weight:bold;color:#d09846">YOUR DONATIONS. YOUR IMPACT.</p>
                <h1 style="margin:0 0 16px;font-size:32px;line-height:36px;letter-spacing:.4px;text-transform:uppercase;color:#efeeec">Thank you for your support!</h1>
                <p style="margin:0;font-size:16px;line-height:26px;color:#d6d2d9">View your donations, manage your incentive selections, and use available Wallet credit.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr>
                  <td align="center" bgcolor="#d09846" style="border-radius:4px;background-color:#d09846"><a href="${htmlUrl}" style="display:block;padding:15px 24px;color:#191919;font-size:15px;line-height:20px;letter-spacing:1px;font-weight:bold;text-decoration:none;text-transform:uppercase">Open your wallet &rarr;</a></td>
                </tr></table>
                <p style="margin:0;font-size:13px;line-height:21px;color:#c6c1cc">Your sign-in link is valid for <strong style="color:#efeeec">30 days</strong>.</p>
                <p style="margin:24px 0 0;font-size:12px;line-height:19px;color:#bdb7c3">Button not working? Copy this link into your browser:<br><a href="${htmlUrl}" style="color:inherit;word-break:break-all">${htmlUrl}</a></p>
              </td></tr>
              <tr><td style="padding:20px 24px"><p style="margin:0;font-size:12px;line-height:20px;color:#bdb7c3">This link signs you in. Keep it private and do not forward this email.</p></td></tr>
            </table>
            <!--[if mso]></td></tr></table><![endif]-->
          </td></tr>
        </table>
      </body>
      </html>`.replace(/>\s+</g, '><'),
    attachments: [
      {
        filename: 'esa-emblem.png',
        path: fileURLToPath(new URL('../assets/esa-emblem.png', import.meta.url)),
        contentType: 'image/png',
        contentDisposition: 'inline',
        cid: 'esa-emblem',
      },
    ],
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
