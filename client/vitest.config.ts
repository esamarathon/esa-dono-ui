import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/lib/tracing.ts', 'src/config.ts'],
      // `include` makes untested files appear at 0% (rather than dropping out
      // of the metric), so a new page shipped without tests drags coverage
      // down and trips the thresholds below.
      // Global floor matching current coverage (~23% stmts / 24% lines). Raise
      // these as tests are added. Once every src file has baseline coverage,
      // enable `perFile: true` so a new 0%-covered page fails CI (this is the
      // mechanism that catches a page that was shipped with no tests at all).
      thresholds: {
        statements: 15,
        branches: 10,
        functions: 12,
        lines: 15,
      },
    },
  },
});
