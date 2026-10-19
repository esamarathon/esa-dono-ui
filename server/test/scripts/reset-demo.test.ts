import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/reset-demo.sh', import.meta.url));

it.each([
  { key: '', authExit: '0', expectedCalls: [], message: 'ADMIN_API_KEY' },
  {
    key: 'wrong-key',
    authExit: '1',
    expectedCalls: ['ps', 'auth'],
    message: 'authentication check failed',
  },
  {
    key: 'test-admin-key',
    authExit: '0',
    expectedCalls: ['ps', 'auth', 'down'],
    message: '',
  },
])(
  'checks credentials before destroying data (key: "$key", auth result: $authExit)',
  async ({ key, authExit, expectedCalls, message }) => {
    const dir = await mkdtemp(join(tmpdir(), 'reset-demo-'));
    const log = join(dir, 'docker-calls');
    try {
      await writeFile(log, '');
      await writeFile(
        join(dir, 'docker'),
        `#!/bin/sh
case "$*" in
  'compose ps -q dono-backend')
    echo ps >> "$CALL_LOG"
    echo backend-container
    ;;
  'compose exec -T -e ADMIN_API_KEY dono-backend node --input-type=module -e '*)
    echo auth >> "$CALL_LOG"
    exit "$AUTH_CHECK_EXIT"
    ;;
  'compose down -v')
    echo down >> "$CALL_LOG"
    exit 99
    ;;
  *) exit 98 ;;
esac
`,
        { mode: 0o755 },
      );
      await expect(
        exec('bash', [script], {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            DEMO_RESET_ALLOWED: '1',
            ADMIN_API_KEY: key,
            CALL_LOG: log,
            AUTH_CHECK_EXIT: authExit,
          },
        }),
      ).rejects.toMatchObject({
        code: expectedCalls.includes('down') ? 99 : 1,
        stderr: expect.stringContaining(message),
      });
      expect((await readFile(log, 'utf8')).trim().split('\n').filter(Boolean)).toEqual(
        expectedCalls,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('seeds through the first of several backend networks that reaches it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reset-demo-'));
  const log = join(dir, 'docker-calls');
  try {
    await writeFile(log, '');
    // Like Docker: `{{$k}}` concatenates network names; `{{println $k}}` puts one per line.
    await writeFile(
      join(dir, 'docker'),
      `#!/bin/sh
case "$*" in
  'compose ps -q dono-backend') echo backend-container ;;
  'compose exec -T -e ADMIN_API_KEY dono-backend node --input-type=module -e '*) exit 0 ;;
  'compose down -v'|'compose up -d') exit 0 ;;
  'inspect backend-container --format '*println*) printf 'esa-dono-pollers\\nesa-dono-ui_app\\n' ;;
  'inspect backend-container --format '*) printf 'esa-dono-pollersesa-dono-ui_app\\n' ;;
  'run --rm --network '*' curlimages/curl:'*)
    echo "health $4" >> "$CALL_LOG"
    [ "$4" = esa-dono-ui_app ]
    ;;
  'run --rm --network '*' -v '*)
    echo "seed $4" >> "$CALL_LOG"
    exit 97
    ;;
  *) exit 98 ;;
esac
`,
      { mode: 0o755 },
    );
    // The host port is unreachable, and waiting is instant.
    await writeFile(join(dir, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    await writeFile(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(
      exec('bash', [script], {
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          DEMO_RESET_ALLOWED: '1',
          ADMIN_API_KEY: 'test-admin-key',
          CALL_LOG: log,
        },
      }),
    ).rejects.toMatchObject({ code: 97 });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'health esa-dono-pollers',
      'health esa-dono-ui_app',
      'seed esa-dono-ui_app',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
