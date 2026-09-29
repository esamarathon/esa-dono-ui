import { describe, it, expect, vi } from 'vitest';

describe('sendMagicLink', () => {
  it('sends email with correct URL', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-id' });
    vi.doMock('nodemailer', () => ({
      default: {
        createTransport: () => ({ sendMail: mockSendMail }),
      },
    }));

    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.SMTP_HOST = 'localhost';
    process.env.SMTP_PORT = '1025';
    process.env.EMAIL_FROM = 'test@example.com';

    const { sendMagicLink } = await import('../../services/email.js');

    await sendMagicLink('donor@example.com', 'abc123');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'donor@example.com',
        subject: 'Your Donation Wallet Link',
      }),
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('http://localhost:5173/api/auth/magic?token=abc123'),
      }),
    );
  });
});
