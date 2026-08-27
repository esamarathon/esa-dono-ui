import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  processAndStore,
  publicUrlFor,
  deleteUploadByUrl,
  ensureUploadsDir,
  UPLOADS_DIR,
} from '../../lib/uploads.js';

describe('uploads', () => {
  it('publicUrlFor builds the public URL', () => {
    expect(publicUrlFor('abc.webp')).toBe('/api/uploads/abc.webp');
  });

  it('processAndStore resizes and re-encodes to webp', async () => {
    const img = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const filename = await processAndStore(img);

    expect(filename).toMatch(/\.webp$/);
    const meta = await sharp(await readFile(join(UPLOADS_DIR, filename))).metadata();
    expect(meta.format).toBe('webp');

    await deleteUploadByUrl(publicUrlFor(filename));
  });

  it('deleteUploadByUrl ignores non-upload URLs and path traversal', async () => {
    await expect(deleteUploadByUrl(null)).resolves.toBeUndefined();
    await expect(deleteUploadByUrl('https://example.com/x.webp')).resolves.toBeUndefined();
    await expect(deleteUploadByUrl('/api/uploads/../etc/passwd')).resolves.toBeUndefined();
    await expect(deleteUploadByUrl('/api/uploads/missing.webp')).resolves.toBeUndefined();
  });

  it('ensureUploadsDir creates the uploads directory', async () => {
    await expect(ensureUploadsDir()).resolves.toBeUndefined();
  });
});
