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
      // Thresholds updated to match current coverage levels (~80% statements).
      // Raise these as coverage improves. Enable `perFile: true` once every file
      // has baseline coverage so a new 0%-covered page fails CI immediately.
      thresholds: {
        statements: 78,
        branches: 65,
        functions: 68,
        lines: 80,
      },
    },
  },
});
