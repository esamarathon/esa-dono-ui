/**
 * The email half of the feedback notification. Fully optional: with no
 * SMTP_* / FEEDBACK_RECIPIENTS configured it logs one line and returns
 * "skipped", and the queue page + Discord webhook still work. Never throws —
 * a failed mail must not fail the sender's request.
 *
 * Uses the same SMTP_* environment the magic-link mailer already reads
 * (services/email.ts), so one relay serves both.
 */

import nodemailer from 'nodemailer';
import { feedbackRef, firstChars } from '@dono/shared';

export interface FeedbackMailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  recipients: string[];
}

export function feedbackMailConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FeedbackMailConfig | null {
  const recipients = (env.FEEDBACK_RECIPIENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = (env.SMTP_PASS ?? '').replace(/\s+/g, '');
  if (!host || !user || !pass || recipients.length === 0) return null;
  return {
    host,
    port: Number(env.SMTP_PORT ?? 587) || 587,
    user,
    pass,
    from: env.EMAIL_FROM?.trim() || `Donation Platform <${user}>`,
    recipients,
  };
}

export interface FeedbackMail {
  id: string;
  senderLabel: string;
  pageUrl: string;
  route: string;
  viewport: string;
  message: string;
  createdAt: Date;
  /** Subject/diagnostics tag for a test instance; null = none. */
  instance?: string | null;
  diagnosticsErrorCount?: number;
  screenshot?: { filename: string; content: Buffer; contentType: string } | null;
}

function diagnosticsLine(count: number | undefined): string {
  if (count === undefined) return 'Diagnostics: not captured.';
  if (count === 0) return 'Diagnostics: no client errors or failed requests.';
  return `Diagnostics: ${count} client error${count === 1 ? '' : 's'} / failed request${count === 1 ? '' : 's'} (open the item in the queue).`;
}

export function renderFeedbackMail(m: FeedbackMail): { subject: string; text: string } {
  const ref = feedbackRef(m.id);
  const tag = m.instance ? ` ${m.instance}` : '';
  const subject = `[Dono feedback${tag}] ${ref} — ${m.senderLabel}: ${firstChars(m.message, 60)}`;
  const text = [
    `${ref} from ${m.senderLabel}`,
    '',
    `Page:      ${m.pageUrl || '-'}`,
    `Route:     ${m.route || '-'}`,
    `Viewport:  ${m.viewport || '-'}`,
    `Sent:      ${m.createdAt.toISOString()}`,
    '',
    m.message,
    '',
    diagnosticsLine(m.diagnosticsErrorCount),
    m.screenshot ? 'Screenshot attached.' : 'No screenshot could be taken on the sender’s side.',
  ].join('\n');
  return { subject, text };
}

export interface FeedbackMailTransport {
  sendMail(options: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    attachments?: { filename: string; content: Buffer; contentType: string }[];
  }): Promise<unknown>;
}

export type FeedbackMailOutcome = 'sent' | 'skipped' | 'failed';

export async function sendFeedbackMail(
  m: FeedbackMail,
  deps: { config?: FeedbackMailConfig | null; transport?: FeedbackMailTransport } = {},
): Promise<FeedbackMailOutcome> {
  const config = deps.config === undefined ? feedbackMailConfigFromEnv() : deps.config;
  if (!config) {
    console.info(
      `[feedback] ${feedbackRef(m.id)}: email skipped (SMTP_* / FEEDBACK_RECIPIENTS not configured)`,
    );
    return 'skipped';
  }
  const transport: FeedbackMailTransport =
    deps.transport ??
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
      // A blackholed relay must not hold a request for nodemailer's default.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  const { subject, text } = renderFeedbackMail(m);
  try {
    await transport.sendMail({
      from: config.from,
      to: config.recipients,
      subject,
      text,
      attachments: m.screenshot
        ? [
            {
              filename: m.screenshot.filename,
              content: m.screenshot.content,
              contentType: m.screenshot.contentType,
            },
          ]
        : undefined,
    });
    return 'sent';
  } catch (err) {
    console.warn(`[feedback] ${feedbackRef(m.id)}: email failed: ${err}`);
    return 'failed';
  }
}
