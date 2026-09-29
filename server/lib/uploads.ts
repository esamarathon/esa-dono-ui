/**
 * Upload storage helper.
 *
 * - UPLOADS_DIR: resolved from env (defaults to /data/uploads in prod;
 *   server/uploads for local dev / tests).
 * - Incoming files are held in memory by multer, then processed by sharp:
 *   resized to max 800 px wide (no upscaling), EXIF-rotated, re-encoded to
 *   webp @ quality 80.  Typical 2 MB phone photo → 50–150 KB.
 * - Stored as <uuid>.webp; served at /api/uploads/<uuid>.webp with immutable
 *   cache headers so browsers (and a future CDN) cache aggressively.
 * - deleteUploadByUrl() is best-effort: it only unlinks files whose URL starts
 *   with our own /api/uploads/ prefix, so a reward that previously held an
 *   external URL is never touched.
 */

import { mkdir, unlink } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

export const UPLOADS_DIR: string =
  process.env.UPLOADS_DIR ??
  (process.env.NODE_ENV === 'production' ? '/data/uploads' : resolve(__dirname, '../uploads'));

export const UPLOADS_URL_PREFIX = '/api/uploads/';

/** Ensure the uploads directory exists (called once at server startup). */
export async function ensureUploadsDir(): Promise<void> {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Multer (memory storage — sharp processes the buffer before writing)
// ---------------------------------------------------------------------------

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MAX_RAW_BYTES = 8 * 1024 * 1024; // 8 MB raw input (resized output is much smaller)

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RAW_BYTES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image type: ${file.mimetype}. Allowed: jpeg, png, webp, gif.`));
    }
  },
});

// ---------------------------------------------------------------------------
// Processing + storage
// ---------------------------------------------------------------------------

/**
 * Resize, EXIF-rotate, and re-encode a raw image buffer to webp, then write
 * it to UPLOADS_DIR.  Returns the generated filename (<uuid>.webp).
 */
export async function processAndStore(buffer: Buffer): Promise<string> {
  const filename = `${randomUUID()}.webp`;
  const dest = join(UPLOADS_DIR, filename);
  await sharp(buffer)
    .rotate() // honour EXIF orientation
    .resize({ width: 800, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(dest);
  return filename;
}

/** Build the public URL for a stored filename. */
export function publicUrlFor(filename: string): string {
  return `${UPLOADS_URL_PREFIX}${filename}`;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Best-effort delete of a file referenced by one of our own /api/uploads/ URLs.
 * Silently ignores missing files and non-upload URLs (e.g. remote http:// URLs
 * that may have been stored from a URL-field era).
 */
export async function deleteUploadByUrl(url: string | null | undefined): Promise<void> {
  if (!url?.startsWith(UPLOADS_URL_PREFIX)) return;
  const filename = url.slice(UPLOADS_URL_PREFIX.length);
  // Guard against path traversal (filename must be a plain uuid.webp)
  if (filename.includes('/') || filename.includes('..')) return;
  try {
    await unlink(join(UPLOADS_DIR, filename));
  } catch {
    // File already gone or never written — not an error
  }
}
