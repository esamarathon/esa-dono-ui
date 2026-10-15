import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Static regression guard for the donor-email leak documented at the top of
 * server/routes/moderator.ts (fixed in 87ad5e4, then again for the donations
 * endpoints). Behavioral tests only cover the specific endpoints someone
 * remembered to assert on — this scans the whole file so a `donor: { select:
 * { email: ... } } }` (or equivalent) added to *any* moderator handler fails
 * CI immediately, regardless of which route it's added to.
 *
 * If this test fails, you almost certainly added donor.email to a moderator
 * response. Use `donor_name` (a plain column, no join needed) instead — do
 * not weaken this test to make a change pass.
 */
describe('moderator routes never select/include donor.email', () => {
  it('traces every service imported by the shared identity routes, including transitive imports', () => {
    const visited = new Set<string>();
    const services = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file) || !existsSync(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf-8');
      if (file.includes('/services/')) services.add(file);
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1]?.startsWith('.'))
          visit(resolve(dirname(file), match[1]).replace(/\.js$/, '.ts'));
      }
    };
    visit(fileURLToPath(new URL('../../routes/identityRoutes.ts', import.meta.url)));
    expect([...services].some((file) => file.endsWith('/defaultGoal.ts'))).toBe(true);
    for (const file of services) {
      const code = readFileSync(file, 'utf-8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(code, file).not.toMatch(/donor:\s*{\s*select:\s*{\s*email\b/);
    }
  });
  it.each([
    '../../routes/moderator.ts',
    '../../routes/identityRoutes.ts',
    '../../services/reversal.ts',
    '../../services/poolAccounting.ts',
    '../../services/accountingStats.ts',
    '../../services/unusedPool.ts',
    '../../services/eventEnd.ts',
    '../../services/incentiveLifecycle.ts',
    '../../services/channels.ts',
    '../../services/events.ts',
    '../../services/staffRead.ts',
    '../../services/rewardFunding.ts',
    '../../services/defaultGoal.ts',
  ])('has no donor.select.email pattern in %s code (comments excluded)', (file) => {
    const path = fileURLToPath(new URL(file, import.meta.url));
    const source = readFileSync(path, 'utf-8');

    // Strip `//` line comments so this test can document the forbidden
    // pattern in prose without triggering on itself.
    const code = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    const donorEmailSelect = /donor:\s*{\s*select:\s*{\s*email\b/;
    expect(code).not.toMatch(donorEmailSelect);
  });
});
