// THROWAWAY (#172): Vite config for the standalone staff-views prototype. No API proxy.
// Run from client/: npm run prototype:staff-views
// Build: npx vite build --config src/pages/admin/prototype-staff-pool-views/vite.config.ts \
//          --base /prototypes/staff-pool-views/ --outDir <dir> --emptyOutDir
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/pages/admin/prototype-staff-pool-views',
  // Relative to root: client/public, so the fonts load under the base path.
  publicDir: '../../../../public',
  plugins: [react()],
  define: { 'import.meta.env.STAFF_PROTOTYPE': 'true' },
  server: { host: true },
});
