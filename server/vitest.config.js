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
  },
});
