import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { SendMailOptions } from 'nodemailer';

const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn<(mail: SendMailOptions) => Promise<{ messageId: string }>>(),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));

beforeEach(() => {
  vi.resetModules();
  mockSendMail.mockReset().mockResolvedValue({ messageId: 'test-id' });
  vi.stubEnv('APP_BASE_URL', 'https://donate.example.com');
  vi.stubEnv('SMTP_HOST', 'localhost');
  vi.stubEnv('EMAIL_FROM', 'ESA <test@example.com>');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendMagicLink', () => {
  it('preserves the recipient, sender, subject, and server-side magic-link route', async () => {
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        from: 'ESA <test@example.com>',
        to: 'donor@example.com',
        subject: 'Your Donation Wallet Link',
        html: expect.stringContaining(
          'href="https://donate.example.com/api/auth/magic?token=abc123"',
        ),
      }),
    );
  });

  it('uses ESA Donations as the default friendly sender name', async () => {
    vi.stubEnv('EMAIL_FROM', '');
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'ESA Donations <no-reply@example.com>' }),
    );
  });

  it('uses the approved dark design, thanks the donor, and keeps wallet access clear', async () => {
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    const mail = mockSendMail.mock.lastCall?.[0];
    if (typeof mail?.html !== 'string') throw new Error('Expected an HTML email');
    expect(mail.html).toContain('Thank you for your support!');
    expect(mail.html).toContain('Open your wallet');
    expect(mail.html).toContain('manage your incentive selections');
    expect(mail.html).toContain('Wallet credit');
    expect(mail.html).toContain('30 days');
    expect(mail.html).toContain('Keep it private');
    for (const color of ['#191919', '#efeeec', '#734e9e', '#d09846']) {
      expect(mail.html).toContain(color);
    }
    expect(mail.html).not.toMatch(/Complete payment|winning bidder|@font-face|data:image/i);
    expect(Buffer.byteLength(mail.html)).toBeLessThan(4 * 1024);
  });

  it('includes a plain-text alternative with thanks, the same link, and privacy guidance', async () => {
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(
          /Thank you for your support![\s\S]*https:\/\/donate\.example\.com\/api\/auth\/magic\?token=abc123[\s\S]*30 days[\s\S]*Keep it private/,
        ),
      }),
    );
  });

  it('embeds a small PNG by content ID and builds a complete email without fetching assets', async () => {
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    const mail = mockSendMail.mock.lastCall?.[0];
    if (typeof mail?.html !== 'string') throw new Error('Expected an HTML email');
    expect(mail.html).toContain('src="cid:esa-emblem"');
    expect(mail.html).not.toMatch(/<img[^>]+src="https?:/i);
    expect(mail.attachments).toEqual([
      expect.objectContaining({
        filename: 'esa-emblem.png',
        contentType: 'image/png',
        contentDisposition: 'inline',
        cid: 'esa-emblem',
      }),
    ]);

    const nodemailer = await vi.importActual<typeof import('nodemailer')>('nodemailer');
    const transport = nodemailer.default.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const result = await transport.sendMail(mail);
    const mime = result.message.toString();
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).toContain('Content-Type: text/html');
    expect(mime).toContain('Content-Type: image/png');
    expect(mime).toContain('Content-ID: <esa-emblem>');
    expect(mime).toContain('Content-Disposition: inline');
    expect(Buffer.byteLength(mime)).toBeLessThan(12 * 1024);
  });

  it('escapes the link in HTML without changing its plain-text representation', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://donate.example.com/"branding"');
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('/&quot;branding&quot;/api/auth/magic?token=abc123'),
        text: expect.stringContaining('/"branding"/api/auth/magic?token=abc123'),
      }),
    );
  });

  it('keeps development logging when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { sendMagicLink } = await import('../../services/email.js');
    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Magic link for donor@example.com: https://donate.example.com/api/auth/magic?token=abc123',
    );
  });
});
