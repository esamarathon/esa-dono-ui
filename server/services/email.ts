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
  const url = `${baseUrl}/wallet?token=${token}`;

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
