import { describe, it, expect, vi } from 'vitest';
import {
  feedbackMailConfigFromEnv,
  renderFeedbackMail,
  sendFeedbackMail,
  type FeedbackMail,
} from '../../services/feedbackMailer.js';

function mail(overrides: Partial<FeedbackMail> = {}): FeedbackMail {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    senderLabel: 'donor 11111111',
    pageUrl: 'http://localhost:3001/donate',
    route: '/donate',
    viewport: '1600x900',
    message: 'The counter does not move',
    createdAt: new Date('2026-11-13T00:00:00.000Z'),
    ...overrides,
  };
}

describe('feedbackMailer', () => {
  describe('feedbackMailConfigFromEnv', () => {
    it('returns null while any required variable is missing', () => {
      expect(feedbackMailConfigFromEnv({})).toBeNull();
      expect(
        feedbackMailConfigFromEnv({
          SMTP_HOST: 'smtp.example.com',
          SMTP_USER: 'u',
          SMTP_PASS: 'p',
        }),
      ).toBeNull();
      expect(
        feedbackMailConfigFromEnv({
          SMTP_HOST: 'smtp.example.com',
          SMTP_USER: 'u',
          SMTP_PASS: 'p',
          FEEDBACK_RECIPIENTS: '  ',
        }),
      ).toBeNull();
    });

    it('builds the config from SMTP_* + FEEDBACK_RECIPIENTS', () => {
      const config = feedbackMailConfigFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_USER: 'u@example.com',
        SMTP_PASS: 'p',
        EMAIL_FROM: 'Donation Platform <no-reply@example.com>',
        FEEDBACK_RECIPIENTS: 'a@example.com, b@example.com',
      });
      expect(config).toEqual({
        host: 'smtp.example.com',
        port: 465,
        user: 'u@example.com',
        pass: 'p',
        from: 'Donation Platform <no-reply@example.com>',
        recipients: ['a@example.com', 'b@example.com'],
      });
    });
  });

  describe('renderFeedbackMail', () => {
    it('renders the subject and body with the human reference', () => {
      const { subject, text } = renderFeedbackMail(mail());
      expect(subject).toBe(
        '[Dono feedback] FB-11111111 — donor 11111111: The counter does not move',
      );
      expect(text).toContain('FB-11111111 from donor 11111111');
      expect(text).toContain('The counter does not move');
      expect(text).toContain('Diagnostics: not captured.');
      expect(text).toContain('No screenshot could be taken');
    });

    it('labels diagnostics counts and the test instance', () => {
      const { subject, text } = renderFeedbackMail(
        mail({
          instance: 'TEST',
          diagnosticsErrorCount: 2,
          screenshot: { filename: 'FB-1.jpg', content: Buffer.alloc(0), contentType: 'image/jpeg' },
        }),
      );
      expect(subject).toContain('[Dono feedback TEST]');
      expect(text).toContain('Diagnostics: 2 client errors / failed requests');
      expect(text).toContain('Screenshot attached.');
    });
  });

  describe('sendFeedbackMail', () => {
    it('skips (and says so) when unconfigured', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const outcome = await sendFeedbackMail(mail(), { config: null });
      expect(outcome).toBe('skipped');
      expect(info).toHaveBeenCalled();
      info.mockRestore();
    });

    it('sends through the injected transport with the attachment', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const config = feedbackMailConfigFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u@example.com',
        SMTP_PASS: 'p',
        FEEDBACK_RECIPIENTS: 'a@example.com',
      })!;
      const outcome = await sendFeedbackMail(
        mail({
          screenshot: {
            filename: 'FB-11111111.jpg',
            content: Buffer.from('x'),
            contentType: 'image/jpeg',
          },
        }),
        { config, transport: { sendMail } },
      );
      expect(outcome).toBe('sent');
      expect(sendMail).toHaveBeenCalledTimes(1);
      const options = sendMail.mock.calls[0]![0];
      expect(options.to).toContain('a@example.com');
      expect(options.attachments).toHaveLength(1);
      expect(options.attachments[0].filename).toBe('FB-11111111.jpg');
    });

    it('returns failed instead of throwing when the transport refuses', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = feedbackMailConfigFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u@example.com',
        SMTP_PASS: 'p',
        FEEDBACK_RECIPIENTS: 'a@example.com',
      })!;
      const outcome = await sendFeedbackMail(mail(), {
        config,
        transport: { sendMail: vi.fn().mockRejectedValue(new Error('relay refused')) },
      });
      expect(outcome).toBe('failed');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
