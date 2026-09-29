import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { isFeatureFlagEnabled } from '../services/featureFlags.js';
import { sendFeedbackToDiscord } from '../services/feedback.js';
import { feedbackLimit } from '../middleware/rateLimit.js';

const router = Router();

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_TEXT_LENGTH = 2000;
const MAX_METADATA_JSON_LENGTH = 5000;
const ALLOWED_SCREENSHOT_MIME = new Set(['image/jpeg', 'image/png']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCREENSHOT_BYTES },
  fileFilter(_req, file, cb) {
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

router.post(
  '/',
  feedbackLimit,
  requireFeedbackEnabled,
  upload.single('screenshot'),
  async (req: Request, res: Response) => {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({
        error: `Feedback text is required and must be 1-${MAX_TEXT_LENGTH} characters`,
      });
    }

    const metadata = parseMetadata(req.body.metadata);
    const screenshot = req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : null;

    try {
      await sendFeedbackToDiscord({
        text,
        metadata: {
          url: asOptionalString(metadata.url),
          donorId: asOptionalString(metadata.donorId),
          channelId: asOptionalString(metadata.channelId),
          channelName: asOptionalString(metadata.channelName),
          userAgent: asOptionalString(metadata.userAgent),
          viewport: asOptionalString(metadata.viewport),
          cartSummary: asOptionalString(metadata.cartSummary),
        },
        screenshot,
      });
      res.status(200).json({ success: true });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: (err as Error).message });
    }
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
