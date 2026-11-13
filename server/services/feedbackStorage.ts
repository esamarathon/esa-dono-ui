/**
 * Where feedback report files (screenshot, DOM snapshot) live.
 *
 * Default: `/data/feedback` in production (the backend data volume, like
 * UPLOADS_DIR — the files must survive a container rebuild) and
 * `server/backups/feedback` in dev. Override with FEEDBACK_DIR.
 *
 * Paths stored in the database are RELATIVE to this directory and are always
 * resolved through safeResolve(): a path that escapes the directory is a bug,
 * never a read.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url)); // server/services

export function feedbackDir(): string {
  const configured = process.env.FEEDBACK_DIR?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === 'production') return '/data/feedback';
  return resolve(serverDir, '../backups/feedback');
}

function safeResolve(relativePath: string): string {
  const base = feedbackDir();
  const abs = resolve(base, relativePath);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`feedback path escapes FEEDBACK_DIR: ${relativePath}`);
  }
  return abs;
}

/** Absolute on-disk path of a stored file (the CLI prints it for the dev loop). */
export function absoluteFeedbackPath(relativePath: string): string {
  return safeResolve(relativePath);
}

export async function saveFeedbackFile(relativePath: string, bytes: Uint8Array): Promise<void> {
  const abs = safeResolve(relativePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

/** null when the file is gone (deleted, or never written). */
export async function readFeedbackFile(relativePath: string): Promise<Buffer | null> {
  try {
    return await readFile(safeResolve(relativePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
