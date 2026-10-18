import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor } from '../../scripts/simulator/executor.js';
import type { Catalog, DecisionEntry } from '../../scripts/simulator/types.js';

const baseUrl = 'http://simulator.test';
const catalog: Catalog = {
  channels: ['channel'],
  rewards: ['reward', 'reward2'],
  polls: [{ pollRef: 'poll', options: ['option'] }],
  goals: ['goal'],
  auctions: [],
  resolve: {
    channel: 'channel-id',
    reward: 'reward-id',
    reward2: 'reward2-id',
    poll: 'poll-id',
    option: 'option-id',
    goal: 'goal-id',
  },
  channelOf: {},
  pledgeableRewards: ['reward', 'reward2'],
  rewardCostCents: { reward: 100, reward2: 200 },
};

function decision(
  action: DecisionEntry['action'],
  overrides: Partial<DecisionEntry> = {},
): DecisionEntry {
  return { seq: 7, delayMs: 0, actor: { donorRef: 'donor1' }, action, params: {}, ...overrides };
}

function response(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function pledge(): DecisionEntry {
  return decision('PLEDGE_CHECKOUT', {
    targetRef: { channelRef: 'channel' },
    items: [{ kind: 'GOAL', goalRef: 'goal', amountCents: 500 }],
  });
}

const fetchMock = vi.fn<typeof fetch>();
let executor: Executor;

async function fund(): Promise<void> {
  fetchMock.mockResolvedValueOnce(response({ token: 'token1' }));
  await executor.execute(decision('DONATE', { params: { amountCents: 5000 } }));
  fetchMock.mockClear();
}

function preparePledge(
  state: unknown = { format: 'POOLED', status: 'FULFILLED' },
  reward = false,
  postStatus = 200,
) {
  fetchMock.mockResolvedValueOnce(response({ balance_remaining: 5000 }));
  if (reward)
    fetchMock.mockResolvedValueOnce(
      response([{ id: 'reward-id', cost_cents: 100, type: 'DIGITAL' }]),
    );
  fetchMock.mockResolvedValueOnce(
    response({ pledge_token: 'confirmed', new_money_cents: 0 }, postStatus),
  );
  if (postStatus === 200) fetchMock.mockResolvedValueOnce(response(state));
}

function expectPost(
  path: string,
  body: Record<string, unknown>,
  authorization = 'Bearer token1',
): void {
  if (path !== '/api/pledge') expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls.find(
    ([url, init]) => url === `${baseUrl}${path}` && init?.method === 'POST',
  )!;
  expect(call).toBeDefined();
  expect(call[0]).toBe(`${baseUrl}${path}`);
  expect(call[1]).toMatchObject({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
  });
  const sentBody = call[1]?.body;
  if (typeof sentBody !== 'string') throw new Error('Expected a JSON string body');
  if (path === '/api/pledge') {
    expect(JSON.parse(sentBody)).toMatchObject(body);
    expect(JSON.parse(sentBody)).toMatchObject({
      pledge_amount_cents: expect.any(Number),
      draft_id: expect.any(String),
      plan: expect.any(Object),
    });
  } else expect(JSON.parse(sentBody)).toEqual(body);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  executor = new Executor({ baseUrl, adminKey: 'admin-secret', runId: 'run1', catalog });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Simulator Executor', () => {
  it('maps every v2 cart line, per-unit reward amounts, quantities, channel and metadata', async () => {
    await fund();
    fetchMock
      .mockResolvedValueOnce(response({ balance_remaining: 5000 }))
      .mockResolvedValueOnce(
        response([
          { id: 'reward-id', cost_cents: 100, type: 'DIGITAL' },
          { id: 'reward2-id', cost_cents: 200, type: 'DIGITAL' },
        ]),
      )
      .mockResolvedValueOnce(
        response({ pledge_token: 'confirmed', format: 'POOLED', new_money_cents: 0 }),
      )
      .mockResolvedValueOnce(response({ format: 'POOLED', status: 'FULFILLED' }));

    const outcome = await executor.execute(
      decision('PLEDGE_CHECKOUT', {
        targetRef: { channelRef: 'channel' },
        params: {
          pledgeAmountCents: 1000,
          comment: 'Go runners!',
          displayName: 'Visible Donor',
          itemKind: 'GOAL',
          amountCents: 9999,
        },
        items: [
          { kind: 'REWARD', rewardRef: 'reward', amountCents: 100, quantity: 3 },
          { kind: 'POLL_VOTE', pollRef: 'poll', optionRef: 'option', amountCents: 200 },
          { kind: 'GOAL', goalRef: 'goal', amountCents: 500 },
          { kind: 'REWARD', rewardRef: 'reward2', amountCents: 200, quantity: 2 },
        ],
      }),
    );

    const post = fetchMock.mock.calls.find(([url]) => url === `${baseUrl}/api/pledge`);
    expect(post).toBeDefined();
    expect(JSON.parse(post![1]!.body as string)).toMatchObject({
      pledge_amount_cents: 1000,
      draft_id: expect.any(String),
      plan: {
        usage_cents: { reward: 700, poll: 200, goal: 500 },
        wallet_applied_cents: 1000,
        new_money_cents: 0,
        top_up_rows: [
          { selection_index: 1, amount_cents: 800 },
          { selection_index: 2, amount_cents: 500 },
        ],
      },
      channel_id: 'channel-id',
      comment: 'Go runners!',
      display_name: 'Visible Donor',
      items: [
        { kind: 'REWARD', target_id: 'reward-id', amount_cents: 100, quantity: 3 },
        { kind: 'POLL_VOTE', target_id: 'option-id', poll_id: 'poll-id', amount_cents: 200 },
        { kind: 'GOAL', target_id: 'goal-id', amount_cents: 500 },
        { kind: 'REWARD', target_id: 'reward2-id', amount_cents: 200, quantity: 2 },
      ],
    });
    expect(outcome).toMatchObject({
      seq: 7,
      action: 'PLEDGE_CHECKOUT',
      status: 200,
      accepted: true,
    });
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome.note).toBeUndefined();
  });

  it.each([
    { kind: 'REWARD', item: { kind: 'REWARD', target_id: 'reward-id', amount_cents: 100 } },
    {
      kind: 'POLL_VOTE',
      item: { kind: 'POLL_VOTE', target_id: 'option-id', poll_id: 'poll-id', amount_cents: 100 },
    },
    { kind: 'GOAL', item: { kind: 'GOAL', target_id: 'goal-id', amount_cents: 100 } },
  ])('replays a v1 $kind pledge without items or metadata', async ({ kind, item }) => {
    await fund();
    preparePledge(undefined, kind === 'REWARD');
    const outcome = await executor.execute(
      decision('PLEDGE_CHECKOUT', {
        targetRef: {
          channelRef: 'channel',
          rewardRef: 'reward',
          pollRef: 'poll',
          optionRef: 'option',
          goalRef: 'goal',
        },
        params: { itemKind: kind, amountCents: 100 },
      }),
    );
    expectPost('/api/pledge', { channel_id: 'channel-id', items: [item] });
    expect(outcome.accepted).toBe(true);
  });

  it('does not fall back to v1 when an empty v2 items array is present', async () => {
    await fund();
    preparePledge(undefined, false, 400);
    await executor.execute(
      decision('PLEDGE_CHECKOUT', {
        targetRef: { channelRef: 'channel', goalRef: 'goal' },
        params: { itemKind: 'GOAL', amountCents: 500 },
        items: [],
      }),
    );
    expectPost('/api/pledge', { channel_id: 'channel-id', items: [] });
  });

  it('uses displayName for donations, falls back to donorRef, and updates repeat donation tokens', async () => {
    fetchMock.mockResolvedValueOnce(response({ token: 'token1' }));
    const first = await executor.execute(
      decision('DONATE', {
        params: {
          amountCents: 1000,
          displayName: 'Visible Donor',
          comment: 'Hello',
          channelRef: 'channel',
        },
      }),
    );
    expect(first).toMatchObject({ status: 200, accepted: true });
    expectPost(
      '/api/admin/simulate-donation',
      {
        email: 'sim-run1+donor1@demo.test',
        donor_name: 'Visible Donor',
        amount_cents: 1000,
        comment: 'Hello',
        channel_id: 'channel-id',
      },
      'Bearer key_admin_admin-secret',
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response());
    await executor.execute(decision('CLAIM_REWARD', { targetRef: { rewardRef: 'reward' } }));
    expectPost('/api/rewards/reward-id/claim', { claim_data: {}, quantity: 1 });

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response({ token: 'token2' }));
    await executor.execute(decision('DONATE', { params: { amountCents: 2000 } }));
    expectPost(
      '/api/admin/simulate-donation',
      {
        email: 'sim-run1+donor1@demo.test',
        donor_name: 'donor1',
        amount_cents: 2000,
        channel_id: null,
      },
      'Bearer key_admin_admin-secret',
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response());
    await executor.execute(decision('CLAIM_REWARD', { targetRef: { rewardRef: 'reward' } }));
    expectPost('/api/rewards/reward-id/claim', { claim_data: {}, quantity: 1 }, 'Bearer token2');
  });

  it.each([
    {
      entry: decision('CLAIM_REWARD', {
        targetRef: { rewardRef: 'reward', channelRef: 'channel' },
      }),
      path: '/api/rewards/reward-id/claim',
      body: { claim_data: {}, quantity: 1 },
    },
    {
      entry: decision('VOTE_POLL', {
        targetRef: { pollRef: 'poll', optionRef: 'option', channelRef: 'channel' },
        params: { amountCents: 300 },
      }),
      path: '/api/polls/poll-id/vote',
      body: { poll_option_id: 'option-id', amount_cents: 300 },
    },
    {
      entry: decision('CONTRIBUTE_GOAL', {
        targetRef: { goalRef: 'goal', channelRef: 'channel' },
        params: { amountCents: 400 },
      }),
      path: '/api/goals/goal-id/contribute',
      body: { amount_cents: 400 },
    },
  ])(
    'sends the decision Channel with a direct $entry.action spend',
    async ({ entry, path, body }) => {
      await fund();
      fetchMock.mockResolvedValueOnce(response());
      await executor.execute(entry);
      expectPost(path, { channel_id: 'channel-id', ...body });
    },
  );

  it.each([undefined, 4])('forwards direct reward quantity %s (default 1)', async (quantity) => {
    await fund();
    fetchMock.mockResolvedValueOnce(response());
    const outcome = await executor.execute(
      decision('CLAIM_REWARD', {
        targetRef: { rewardRef: 'reward' },
        params: quantity === undefined ? {} : { quantity },
      }),
    );
    expectPost('/api/rewards/reward-id/claim', { claim_data: {}, quantity: quantity ?? 1 });
    expect(outcome).toMatchObject({ status: 200, accepted: true });
  });

  it.each([
    { format: 'POOLED', status: 'OPEN' },
    { format: 'LEGACY', status: 'FULFILLED' },
    { format: 'POOLED', status: 'CANCELLED' },
    { status: 'FULFILLED' },
  ])('checks actual fulfillment state %j without completing Stripe', async (body) => {
    await fund();
    preparePledge(body);
    const outcome = await executor.execute(pledge());
    expectPost('/api/pledge', {
      channel_id: 'channel-id',
      items: [{ kind: 'GOAL', target_id: 'goal-id', amount_cents: 500 }],
    });
    expect(outcome).toMatchObject({ status: 200, accepted: false });
    expect(outcome.note).toContain('pledge not fulfilled (no Stripe in sim)');
  });

  const actions: DecisionEntry[] = [
    decision('DONATE', { params: { amountCents: 500 } }),
    decision('CLAIM_REWARD', { targetRef: { rewardRef: 'reward' } }),
    pledge(),
  ];

  it.each(actions)('reports HTTP failures for $action', async (entry) => {
    await fund();
    fetchMock.mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }));
    const outcome = await executor.execute(entry);
    expect(outcome).toMatchObject({
      seq: entry.seq,
      action: entry.action,
      status: 503,
      accepted: false,
    });
    expect(outcome.note).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(actions)('reports network errors for $action', async (entry) => {
    await fund();
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    const outcome = await executor.execute(entry);
    expect(outcome).toMatchObject({
      seq: entry.seq,
      action: entry.action,
      status: 0,
      accepted: false,
      note: 'executor error: connection refused',
    });
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(actions.filter((entry) => entry.action !== 'DONATE'))(
    'requires a prior donation token for $action',
    async (entry) => {
      const outcome = await executor.execute(entry);
      expect(outcome).toMatchObject({
        status: 0,
        accepted: false,
        note: 'donor donor1 has no token yet (no prior donation)',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
