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
    // Creates a fresh, migrated SQLite DB in a temp dir (tmpfs where possible)
    // for this run, sets DATABASE_URL for the workers, and deletes it after.
    // Do not set DATABASE_URL in `test.env`: it would override that value.
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // Several test files hit the real SQLite test DB directly (each opening
    // its own PrismaClient) for integration-style coverage of tx-based money
    // movement. SQLite serializes writers at the file level, so running
    // those files' tests concurrently across worker threads causes
    // SQLITE_BUSY / "Operations timed out" flakiness. Fully sequential
    // execution trades a bit of speed for a suite that doesn't flake.
    fileParallelism: false,
    // Integration tests share one SQLite file and run under v8 coverage in the
    // pre-commit hook (alongside lint-staged). On small CI/dev hosts the 5s
    // default was hit intermittently by unrelated DB-backed route tests, so
    // allow more headroom. This only bounds how long a hung test may take.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'middleware/**/*.ts', 'routes/**/*.ts', 'services/**/*.ts'],
      // `include` makes untested files appear at 0% (rather than dropping out
      // of the metric). Entry points (index.ts) and config are left out as
      // glue, not behavior.
      // Thresholds updated to match current coverage levels (~79% statements).
      thresholds: {
        statements: 77,
        branches: 65,
        functions: 87,
        lines: 79,
      },
    },
  },
});
