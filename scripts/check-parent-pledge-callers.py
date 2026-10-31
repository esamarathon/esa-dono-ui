#!/usr/bin/env python3
"""Check private caller copies, including purchase with mocked HTTP only; no network/containers."""
import argparse
import ast
import pathlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parent-root', type=pathlib.Path, required=True)
parser.add_argument('--playwright-root', type=pathlib.Path, help='Private exact-version node_modules for full browser typechecking')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
patch = repo / 'scripts/parent-pledge-callers.patch'
files = ['scripts/e2e-incentives.ts', 'scripts/test-incentives.sh', 'staging/incentive-test.py',
         'scripts/e2e-incentives-browser.ts']
with tempfile.TemporaryDirectory(prefix='caller-patch-') as name:
    root = pathlib.Path(name)
    for file in files:
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.parent_root.resolve() / file, target)
    for file in files:
        # Independently accept original/applied files, including a mixed 3+1 state.
        command = ['git', 'apply', f'--include={file}']
        check = subprocess.run([*command, '--check', str(patch)], cwd=root, capture_output=True)
        if check.returncode == 0:
            subprocess.run([*command, str(patch)], cwd=root, check=True)
            print(f'PRIVATE APPLY: {file}', flush=True)
        else:
            # Never force over unrelated edits or assume the whole patch is applied.
            subprocess.run([*command, '--reverse', '--check', str(patch)], cwd=root, check=True)
            print(f'ALREADY APPLIED: {file}', flush=True)
    assert not (root / '.git').exists()
    subprocess.run(['bash', '-n', str(root / files[1])], check=True)
    python = ast.parse((root / files[2]).read_text())
    for statement in python.body:
        if isinstance(statement, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ['fixture', 'probe'] for t in statement.targets):
            subprocess.run(['node', '--check', '--input-type=module'], input=ast.literal_eval(statement.value), text=True, check=True)
    subprocess.run(['python3', str(root / files[2]), '--help'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(repo / 'node_modules/.bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
                    '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node',
                    '--typeRoots', str(repo / 'node_modules/@types'), str(root / files[0])], check=True)
    # Execute only the actual purchase function, not the caller's top-level runtime.
    source = (root / files[0]).read_text()
    start = source.index('async function purchase(')
    end = source.index('\nasync function fund(', start)
    purchase = source[start:end]
    harness = r'''
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
interface Donation { id: string; external_id: string; amount_cents: number; donor_name: string }
const prefix = 'IT-private', backend = 'https://mock.invalid/api';
const state = { channelId: 'channel-fixture' };
const receipts: { label: string; donation: Donation }[] = [];
const calls: { path: string; body?: unknown }[] = [];
const items = [
  { kind: 'REWARD', target_id: 'digital', quantity: 3 },
  { kind: 'POLL_VOTE', poll_id: 'poll-a', target_id: 'option-a', amount_cents: 100 },
  { kind: 'POLL_VOTE', poll_id: 'poll-b', target_id: 'option-b', amount_cents: 200 },
  { kind: 'GOAL', target_id: 'goal-a', amount_cents: 300 },
  { kind: 'GOAL', target_id: 'goal-b', amount_cents: 400 },
];
const canonicalItems = [
  { kind: 'REWARD', target_id: 'digital', quantity: 3, amount_cents: 1500, insertion_order: 0, poll_id: null, unit_price_cents: 500, reward_type: 'DIGITAL', data: null },
  { kind: 'POLL_VOTE', poll_id: 'poll-a', target_id: 'option-a', amount_cents: 100, insertion_order: 1, quantity: 1, unit_price_cents: null, reward_type: null, data: null },
  { kind: 'POLL_VOTE', poll_id: 'poll-b', target_id: 'option-b', amount_cents: 200, insertion_order: 2, quantity: 1, unit_price_cents: null, reward_type: null, data: null },
  { kind: 'GOAL', target_id: 'goal-a', amount_cents: 300, insertion_order: 3, poll_id: null, quantity: 1, unit_price_cents: null, reward_type: null, data: null },
  { kind: 'GOAL', target_id: 'goal-b', amount_cents: 400, insertion_order: 4, poll_id: null, quantity: 1, unit_price_cents: null, reward_type: null, data: null },
];
// Literal server-response fixture; no planner or caller-derived expected money.
// D=1500; independent Pools finish at reward=1500, poll=1500, goal=1500.
const canonicalPlan = {
  pledge_amount_cents: 1500, selections: canonicalItems,
  usage_cents: { reward: 1500, poll: 300, goal: 700 },
  overage_cents: { reward: 0, poll: 0, goal: 0 },
  top_up_rows: [
    { selection_index: 1, amount_cents: 400 }, { selection_index: 2, amount_cents: 800 },
    { selection_index: 3, amount_cents: 343 }, { selection_index: 4, amount_cents: 457 },
  ],
  wallet_applied_cents: 0, new_money_cents: 1500, requires_shipping: false,
};
let review: Record<string, unknown> | undefined;
let settled: Record<string, unknown> | undefined;
const fetch = async (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ path: url, body: JSON.parse(String(init.body)) });
  assert.equal(calls.length, 1);
  assert.equal(url, 'https://mock.invalid/api/pledge');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.ok(init.signal instanceof AbortSignal);
  review = JSON.parse(String(init.body)) as Record<string, unknown>;
  assert.equal(review.pledge_amount_cents, 1500);
  assert.equal(review.channel_id, 'channel-fixture');
  assert.match(String(review.draft_id), /^IT-private-[0-9a-f-]{36}$/);
  assert.match(String(review.email), /^IT-private-[0-9a-f]{6}@example\.test$/);
  assert.equal(review.display_name, 'IT-private Mixed fixture');
  assert.deepEqual(review.items, items);
  assert.deepEqual(review.plan, {});
  return new Response(JSON.stringify({ plan: canonicalPlan, items: canonicalItems }), { status: 409 });
};
async function api<T>(path: string, data?: unknown): Promise<T> {
  calls.push({ path, body: structuredClone(data) });
  const body = data as Record<string, unknown>;
  let result: unknown;
  if (path === '/pledge') {
    assert.ok(review, 'Canonical confirmation must follow the 409 review');
    assert.deepEqual(body, { ...review, plan: canonicalPlan, items: canonicalItems });
    result = { pledge_token: 'exact-fixture-token', pledge_amount_cents: 1500,
      new_money_cents: 1500, wallet_applied_cents: 0, total_cents: 2500 };
  } else if (path === '/admin/simulate-donation') {
    assert.ok(review);
    assert.equal(body.amount_cents, 1500, 'Settled intake must use new money, not old total/category sum');
    assert.equal(body.pledge_token, 'exact-fixture-token');
    assert.equal(body.email, review.email);
    assert.equal(body.donor_name, 'IT-private Mixed fixture');
    assert.equal(body.channel_id, 'channel-fixture');
    assert.match(String(body.external_id), /^IT-private-settled-[0-9a-f-]{36}$/);
    settled = body;
    result = {};
  } else if (path === '/pledge/exact-fixture-token') {
    assert.ok(settled, 'Fulfillment read must follow settled intake');
    assert.equal(data, undefined);
    result = { status: 'FULFILLED' };
  } else if (path === '/admin/donations') {
    assert.ok(settled);
    assert.equal(data, undefined);
    result = [
      { id: 'unrelated', external_id: 'other', amount_cents: 9999, donor_name: 'Other' },
      { id: 'settled-fixture', external_id: settled.external_id, amount_cents: 1500, donor_name: 'IT-private Mixed fixture' },
    ];
  } else {
    throw Error(`Unexpected HTTP/API call (including synthetic Stripe): ${path}`);
  }
  return result as T;
}
'''
    verify = r'''
const donation = await purchase('Mixed fixture', items, 1500);
assert.deepEqual(calls.map(c => c.path), ['https://mock.invalid/api/pledge', '/pledge',
  '/admin/simulate-donation', '/pledge/exact-fixture-token', '/admin/donations']);
assert.equal(donation.id, 'settled-fixture');
assert.equal(donation.amount_cents, 1500);
assert.deepEqual(receipts, [{ label: 'Mixed fixture', donation }]);
console.log('PASS: actual purchase 409 -> canonical D/draft/plan -> exact-token settled new money -> FULFILLED receipt; HTTP/API mocked only');
'''
    test = root / 'purchase-check.mts'
    # A private bad-amount caller proves the oracle rejects the old category sum.
    bad = purchase.replace('amount_cents: pledge.new_money_cents', 'amount_cents: 4500', 1)
    assert bad != purchase, 'Settled intake boundary not found'
    test.write_text(harness + bad + verify)
    compiler = [str(repo / 'node_modules/.bin/tsc'), '--strict', '--skipLibCheck',
                '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
                '--types', 'node', '--typeRoots', str(repo / 'node_modules/@types'), str(test)]
    subprocess.run(compiler, check=True)
    red = subprocess.run(['node', str(test.with_suffix('.mjs'))], capture_output=True, text=True)
    assert red.returncode != 0 and 'Settled intake must use new money' in red.stderr, red.stdout + red.stderr
    print('RED (expected): actual purchase with private 4500 category-sum mutation rejected', flush=True)
    test.write_text(harness + purchase + verify)
    subprocess.run(compiler, check=True)
    subprocess.run(['node', str(test.with_suffix('.mjs'))], check=True)
    browser = (root / files[3]).read_text()
    start = browser.index("      const items = label === 'donations'")
    end = browser.index("      if (label !== 'donations')", start)
    received = browser[start:end]
    browser_harness = r'''
import assert from 'node:assert/strict';
const label = 'donations';
const mixed = { rewards: 3, pollNames: ['Poll A', 'Poll B'], goalNames: ['Goal A', 'Goal B'] };
const report = { fixtures: { goals: [
  { title: 'Goal A', expectedCents: 643 }, { title: 'Goal B', expectedCents: 857 },
] } };
let rows = ['Reward 1', 'Reward 2', 'Reward 3', 'Poll A', 'Poll B', 'Goal A 6.43 USD', 'Goal B 8.57 USD'];
const locator = (entries: string[]) => ({
  count: async () => entries.length,
  innerText: async () => entries.join(' '),
  filter: ({ hasText }: { hasText: string }) => locator(entries.filter(row => row.includes(hasText))),
});
const donation = { locator: (_selector: string) => locator(rows), innerText: async () => rows.join(' ') };
async function verifyReceived() {
'''
    browser_verify = r'''
}
await verifyReceived();
for (const bad of [
  ['Goal A 3.00 USD', 'Goal B 4.00 USD'],
  ['Goal A 8.57 USD', 'Goal B 6.43 USD'],
]) {
  rows = [...rows.slice(0, 5), ...bad];
  await assert.rejects(verifyReceived, 'Old or swapped target amounts must fail');
}
rows = ['Reward 1', 'Reward 2', 'Reward 3', 'Poll A', 'Goal A 6.43 USD', 'Goal B 8.57 USD'];
await assert.rejects(verifyReceived, 'Every received incentive remains required');
console.log('PASS: actual browser received-incentive assertions accept literal 643/857 and reject 3/4, swapped values and a missing item');
'''
    test.write_text(browser_harness + received + browser_verify)
    subprocess.run(compiler, check=True)
    subprocess.run(['node', str(test.with_suffix('.mjs'))], check=True)
    assert 'for (const width of [1024, 1500])' in browser, 'Fixed hardware, not unsupported 768px'
    start = browser.index('        assert.equal(bounds.outer.width')
    end = browser.index("        const items = page!.locator", start)
    containment = browser[start:end]
    bounds_harness = r'''
import assert from 'node:assert/strict';
const bounds = {
  viewport: 1024, outer: { right: 1024, bottom: 600, width: 1024, height: 600 },
  scrollWidth: 1024, clientWidth: 1024, scrollHeight: 600, clientHeight: 600,
  main: { top: 0, bottom: 550 }, actions: { top: 550, bottom: 600 }, reload: { top: 550, bottom: 600 }, itemsOutsideCard: 0,
};
function verifyBounds() {
'''
    bounds_verify = r'''
}
verifyBounds();
for (const mutate of [
  () => bounds.outer.width = 768,
  () => bounds.outer.height = 700,
  () => bounds.scrollWidth = 1025 + 2,
  () => bounds.scrollHeight = 603,
  () => bounds.itemsOutsideCard = 1,
  () => bounds.main.bottom = 553,
  () => bounds.actions.bottom = 603,
]) {
  const original = structuredClone(bounds);
  mutate(); assert.throws(verifyBounds);
  Object.assign(bounds, original);
}
console.log('PASS: actual fixed-hardware containment assertions retain overflow/overlap/item/control guards');
'''
    test.write_text(bounds_harness + containment + bounds_verify)
    subprocess.run(compiler, check=True)
    subprocess.run(['node', str(test.with_suffix('.mjs'))], check=True)
    if args.playwright_root:
        modules = root / 'node_modules'
        modules.mkdir()
        for package in ['playwright', 'playwright-core']:
            (modules / package).symlink_to(args.playwright_root.resolve() / package, target_is_directory=True)
        subprocess.run([str(repo / 'node_modules/.bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
                        '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node',
                        '--typeRoots', str(repo / 'node_modules/@types'), str(root / files[3])], check=True)
        print('PASS: full browser strict typecheck with supplied real Playwright types')
    else:
        print('BOUNDARY: full browser typecheck needs --playwright-root with runtime-matching real types')
    print('PASS: four-file private mixed-state Git apply/reverse-check, shell/Python/embedded JS/strict TS and extracted caller/browser assertions; no network, browser or container execution')
