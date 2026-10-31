import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// npm workspace commands run from server/, while operators also run from root.
// Explicit process configuration always wins over the local development file.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export type DatabaseProvider = 'sqlite' | 'postgresql';

/** The URL selects the provider in both the application and migration runner. */
export function databaseProvider(url: string | undefined): DatabaseProvider {
  if (!url || url.startsWith('file:')) return 'sqlite';
  if (url.startsWith('postgresql:') || url.startsWith('postgres:')) return 'postgresql';
  throw new Error('DATABASE_URL must use file:, postgresql: or postgres:');
}
