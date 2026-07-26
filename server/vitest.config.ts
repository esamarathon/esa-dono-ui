import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite-node (the vitest runner) does not honor `resolve.extensionAlias`, so
  // map relative `.js` specifiers that point at migrated TypeScript sources
  // (lib/services/routes/middleware) to their `.ts` files. NodeNext ESM keeps
  // the `.js` extension in imports even though the source is now TypeScript.
  resolve: {
    alias: [
      {
        find: /^((?:\.{1,2}\/)+(?:lib|services|routes|middleware)\/.*)\.js$/,
        replacement: '$1.ts',
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Several test files hit the real SQLite dev.db directly (each opening
    // its own PrismaClient) for integration-style coverage of tx-based money
    // movement. SQLite serializes writers at the file level, so running
    // those files' tests concurrently across worker threads causes
    // SQLITE_BUSY / "Operations timed out" flakiness. Fully sequential
    // execution trades a bit of speed for a suite that doesn't flake.
    fileParallelism: false,
  },
});
