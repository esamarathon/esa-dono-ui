import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import {
  FEEDBACK_MAX_BODY_BYTES,
  FEEDBACK_MESSAGE_MAX_CHARS,
  FEEDBACK_SNAPSHOT_MAX_BYTES,
  type FeedbackMetadata,
  feedbackRef,
  feedbackStoragePath,
  buildFeedbackDiagnostics,
  sanitizeFeedbackClientDiagnostics,
  serializeFeedbackDiagnostics,
} from '@dono/shared';
import prisma from '../lib/prisma.js';
import { isFeatureFlagEnabled } from '../services/featureFlags.js';
import { sendFeedbackToDiscord } from '../services/feedback.js';
import { sendFeedbackMail } from '../services/feedbackMailer.js';
import { saveFeedbackFile } from '../services/feedbackStorage.js';
import { resolveDonorToken } from '../middleware/donorAuth.js';
import { resolveEffectiveRole } from '../lib/roles.js';
import { feedbackLimit } from '../middleware/rateLimit.js';

const router = Router();

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB (shared cap)
const MAX_METADATA_JSON_LENGTH = 5000;
const MAX_USER_AGENT_LENGTH = 300;
const MAX_PAGE_URL_LENGTH = 500;
const ALLOWED_SCREENSHOT_MIME = new Set(['image/jpeg', 'image/png']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCREENSHOT_BYTES, files: 2 },
  fileFilter(_req, file, cb) {
    if (file.fieldname !== 'screenshot') {
      cb(null, true);
      return;
    }
    if (ALLOWED_SCREENSHOT_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported screenshot type: ${file.mimetype}. Allowed: jpeg, png.`));
    }
  },
});

/** Keys that must never be forwarded to Discord even if present in the client metadata blob. */
const SENSITIVE_KEY_PATTERN = /email|token/i;

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  if (raw.length > MAX_METADATA_JSON_LENGTH) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      clean[key] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Checks the flag before multer runs, so a disabled feature returns 404
 * without buffering the upload (and bad uploads can't mask the 404).
 */
async function requireFeedbackEnabled(_req: Request, res: Response, next: NextFunction) {
  try {
    if (!(await isFeatureFlagEnabled('feedback'))) {
      return res.status(404).json({ error: 'Feedback is not enabled' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The sender's donor, when the request carries a valid session. Feedback is a
 * PUBLIC widget: no session, an expired token or a frozen account means an
 * anonymous report, never a 401 — text alone must always be enough. The
 * effective role rides into the report's diagnostics context only.
 */
async function resolveOptionalDonor(req: Request) {
  const token = resolveDonorToken(req);
  if (!token) return null;
  const donor = await prisma.donor.findUnique({ where: { magic_token: token } });
  if (!donor) return null;
  if (donor.token_expires_at && new Date() > donor.token_expires_at) return null;
  if (donor.is_frozen) return null;
  return { ...donor, role: resolveEffectiveRole(donor.email, donor.role, donor.email_verified) };
}

/**
 * The page URL is sender-controlled and stored for resolvers to open, so it is
 * kept only when it points at this very host over http(s); the route is then
 * derived from it rather than trusted as a separate field.
 */
function samePageUrl(raw: string, req: Request): { pageUrl: string; route: string } {
  try {
    const url = new URL(raw);
    const host = req.headers.host ?? new URL(`http://${req.headers.host ?? 'localhost'}`).host;
    if (url.host !== host || !/^https?:$/.test(url.protocol)) {
      return { pageUrl: '', route: '' };
    }
    return {
      pageUrl: url.href.slice(0, MAX_PAGE_URL_LENGTH),
      route: url.pathname.slice(0, 120),
    };
  } catch {
    return { pageUrl: '', route: '' };
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Screenshots are re-encoded by the browser anyway; verify the magic bytes, not the declared type. */
function looksLikeImage(bytes: Buffer): string | null {
  if (PNG_MAGIC.every((b, i) => bytes[i] === b)) return 'image/png';
  if (JPEG_MAGIC.every((b, i) => bytes[i] === b)) return 'image/jpeg';
  return null;
}

router.post(
  '/',
  feedbackLimit,
  requireFeedbackEnabled,
  // Size gate BEFORE the body is parsed: multer would otherwise buffer the
  // whole thing to enforce the per-file cap.
  (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > FEEDBACK_MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Feedback submission too large' });
    }
    next();
  },
  upload.fields([
    { name: 'screenshot', maxCount: 1 },
    { name: 'snapshot', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > FEEDBACK_MESSAGE_MAX_CHARS) {
      return res.status(400).json({
        error: `Feedback text is required and must be 1-${FEEDBACK_MESSAGE_MAX_CHARS} characters`,
      });
    }

    const donor = await resolveOptionalDonor(req);
    const now = new Date();
    const metadataRaw = parseMetadata(req.body.metadata);
    const { pageUrl, route } = samePageUrl(asOptionalString(metadataRaw.url) ?? '', req);
    const metadata: FeedbackMetadata = {
      // A cross-host or malformed URL is dropped entirely: it is attacker-
      // controlled text that would render as a link in the resolver channels.
      url: pageUrl || null,
      donor_id: donor?.id ?? asOptionalString(metadataRaw.donor_id) ?? null,
      channel_id: asOptionalString(metadataRaw.channel_id) ?? null,
      channel_name: asOptionalString(metadataRaw.channel_name) ?? null,
      viewport: asOptionalString(metadataRaw.viewport)?.slice(0, 40) ?? null,
      cart_summary: asOptionalString(metadataRaw.cart_summary) ?? null,
    };
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, MAX_USER_AGENT_LENGTH);
    const scrollYRaw = Number(req.body.scrollY);
    const scrollY = Number.isFinite(scrollYRaw) && scrollYRaw > 0 ? Math.round(scrollYRaw) : 0;

    // Diagnostics: the browser's part is validated and capped (sender-controlled);
    // the server-side context is stamped here, never trusted from the form.
    // Malformed input is dropped with a log line, never a 4xx.
    const clientDiagnostics = sanitizeFeedbackClientDiagnostics(req.body.diagnostics);
    if (typeof req.body.diagnostics === 'string' && req.body.diagnostics && !clientDiagnostics) {
      console.warn('[feedback] diagnostics field dropped (invalid or too large)');
    }
    const diagnostics = buildFeedbackDiagnostics({
      client: clientDiagnostics,
      context: {
        build_id: 'unknown',
        client_build_id: 'unknown',
        instance: process.env.INSTANCE_LABEL?.trim() || null,
        viewport: metadata.viewport ?? '',
        userAgent,
        sender_role: donor?.role ?? null,
      },
      capturedAt: now,
    });

    // Order of work: write the row → write the files (a failed file is logged
    // and dropped, the row stays) → notify. Text alone is always enough;
    // nothing after the row is allowed to fail the sender's request.
    const row = await prisma.feedback.create({
      data: {
        sender_id: donor?.id ?? null,
        message: text,
        page_url: pageUrl,
        route,
        viewport: metadata.viewport ?? '',
        scroll_y: scrollY,
        user_agent: userAgent,
        diagnostics: serializeFeedbackDiagnostics(diagnostics),
      },
      select: { id: true },
    });
    const ref = feedbackRef(row.id);

    let screenshotBuffer: Buffer | null = null;
    let screenshotMime: string | null = null;
    let screenshotPath: string | null = null;
    let snapshotBuffer: Buffer | null = null;
    let snapshotPath: string | null = null;
    try {
      const uploaded = (req.files as Record<string, Express.Multer.File[]> | undefined)
        ?.screenshot?.[0];
      if (uploaded?.buffer?.length) {
        screenshotMime = looksLikeImage(uploaded.buffer);
        if (!screenshotMime) {
          console.warn(`[feedback] ${ref}: screenshot dropped (not a PNG/JPEG)`);
        } else {
          screenshotBuffer = uploaded.buffer;
          screenshotPath = feedbackStoragePath(
            screenshotMime === 'image/png' ? 'png' : 'jpg',
            now,
            donor?.id ?? null,
          );
          await saveFeedbackFile(screenshotPath, screenshotBuffer);
        }
      }
      const snapshot = (req.files as Record<string, Express.Multer.File[]> | undefined)
        ?.snapshot?.[0];
      if (snapshot?.buffer?.length) {
        if (snapshot.buffer.length > FEEDBACK_SNAPSHOT_MAX_BYTES) {
          console.warn(
            `[feedback] ${ref}: snapshot dropped (${snapshot.buffer.length} bytes > ${FEEDBACK_SNAPSHOT_MAX_BYTES})`,
          );
        } else {
          snapshotBuffer = snapshot.buffer;
          snapshotPath = feedbackStoragePath('html', now, donor?.id ?? null);
          await saveFeedbackFile(snapshotPath, snapshotBuffer);
        }
      }
    } catch (err) {
      console.warn(`[feedback] ${ref}: files not stored: ${err}`);
      screenshotBuffer = null;
      screenshotMime = null;
      screenshotPath = null;
      snapshotBuffer = null;
      snapshotPath = null;
    }
    if (screenshotPath || snapshotPath) {
      await prisma.feedback.update({
        where: { id: row.id },
        data: { screenshot_path: screenshotPath, snapshot_path: snapshotPath },
      });
    }

    // Notifications, after the row is durable. Both swallow their own errors:
    // a webhook outage or an SMTP refusal must never lose a report or 500 a donor.
    try {
      await sendFeedbackToDiscord({
        text,
        metadata,
        screenshot:
          screenshotBuffer && screenshotMime
            ? { buffer: screenshotBuffer, mimetype: screenshotMime }
            : null,
        snapshot: snapshotBuffer ? { buffer: snapshotBuffer } : null,
        diagnosticsErrorCount: diagnostics.error_count,
        userAgent,
      });
    } catch (err) {
      console.warn(`[feedback] ${ref}: Discord notification failed: ${err}`);
    }
    // Email is fire-and-forget: the row is durable, and the sender must never
    // wait on an SMTP handshake (feedbackMailer.ts also bounds the timeouts).
    void sendFeedbackMail({
      id: row.id,
      senderLabel: donor ? `donor ${donor.id.slice(0, 8)}` : 'anonymous',
      pageUrl,
      route,
      viewport: metadata.viewport ?? '',
      message: text,
      createdAt: now,
      instance: diagnostics.context.instance,
      diagnosticsErrorCount: diagnostics.error_count,
      screenshot: screenshotBuffer
        ? {
            filename: `${ref}.${screenshotMime === 'image/png' ? 'png' : 'jpg'}`,
            content: screenshotBuffer,
            contentType: screenshotMime ?? 'image/jpeg',
          }
        : null,
    }).catch((err: unknown) => console.warn(`[feedback] ${ref}: email failed: ${err}`));

    res.status(200).json({ success: true, id: row.id, ref });
  },
);

// Multer error handler (file-type rejection, size exceeded, etc.)
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof Error && err.message.startsWith('Unsupported screenshot type')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

export default router;
