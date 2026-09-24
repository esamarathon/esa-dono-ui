import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/simulate.ts', import.meta.url));
let server: Server | undefined;
let dir: string | undefined;

async function fixture(donationStatus: number) {
  dir = await mkdtemp(join(tmpdir(), 'simulator-cli-'));
  const posts: string[] = [];
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    req.resume();
    if (req.method === 'POST') {
      posts.push(req.url!);
      res.statusCode = donationStatus;
      res.end(JSON.stringify({ token: 'test-donor-token' }));
    } else if (req.url === '/api/channels') {
      res.end(JSON.stringify([{ id: 'channel-1' }]));
    } else if (req.url === '/api/auctions') {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Auctions are not enabled' }));
    } else {
      res.end('[]');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, out: dir, posts };
}

function run(baseUrl: string, out: string, extra: string[] = []) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        cli,
        '--seed',
        'cli-regression',
        '--events',
        '1',
        '--donors',
        '1',
        '--rate',
        '0/s',
        '--base-url',
        baseUrl,
        '--out',
        out,
        ...extra,
      ],
      { cwd: root, env: { ...process.env, ADMIN_API_KEY: 'test-admin-key' }, timeout: 15000 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((err) => (err ? reject(err) : resolve())),
    );
    server = undefined;
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('simulator CLI', () => {
  it('exits nonzero for HTTP 500 during execution, not just discovery errors', async () => {
    const { baseUrl, out, posts } = await fixture(500);
    const result = await run(baseUrl, out);
    expect(posts).toEqual(['/api/admin/simulate-donation']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('errors: 1');
    const outcome = JSON.parse((await readFile(join(out, 'outcomes.jsonl'), 'utf8')).trim());
    expect(outcome.status).toBe(500);
  });

  it('records v2 generation controls and succeeds on accepted donations', async () => {
    const { baseUrl, out } = await fixture(200);
    const result = await run(baseUrl, out, [
      '--repeat-donation-chance',
      '0.6',
      '--traffic',
      'steady',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.simVersion).toBe('v2');
    expect(manifest.args).toMatchObject({ repeatDonationChance: 0.6, traffic: 'steady' });
    const decision = JSON.parse((await readFile(join(out, 'decisions.jsonl'), 'utf8')).trim());
    expect(decision.trafficPhase).toBe('normal');
    expect(decision.actor.profile).toBeTruthy();
  });

  it('replays legacy decisions unchanged rather than regenerating new profiles or amounts', async () => {
    const { baseUrl, out } = await fixture(200);
    const source = join(out, 'legacy.jsonl');
    const entry = {
      seq: 0,
      delayMs: 0,
      actor: { donorRef: 'd1' },
      action: 'DONATE',
      params: { amountCents: 1234, channelRef: 'c1' },
    };
    await writeFile(source, JSON.stringify(entry) + '\n');
    const replayOut = join(out, 'replay');
    const result = await run(baseUrl, replayOut, ['--replay', source]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse((await readFile(join(replayOut, 'decisions.jsonl'), 'utf8')).trim())).toEqual(
      entry,
    );
  });

  it('rejects invalid generation controls', async () => {
    const { baseUrl, out, posts } = await fixture(200);
    const badChance = await run(baseUrl, out, ['--repeat-donation-chance', '2']);
    expect(badChance.code).toBe(1);
    expect(badChance.stderr).toContain('repeatDonationChance');
    const badTraffic = await run(baseUrl, out, ['--traffic', 'chaos']);
    expect(badTraffic.code).toBe(1);
    expect(badTraffic.stderr).toContain('--traffic');
    expect(posts).toEqual([]);
  });
});
