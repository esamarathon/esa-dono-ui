import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import prisma from '../../lib/prisma.js';
import { planPledge, type PledgePlan } from '@dono/shared';
import { createPledge, type PledgeItemInput } from '../../services/pledge.js';
import { createTestChannel } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));

const channels: string[] = [];
const donors: string[] = [];
const drafts: string[] = [];
const rewards: string[] = [];
const goals: string[] = [];
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_pledge_hold');
  await prisma.pendingPledge.deleteMany({ where: { draft_id: { in: drafts } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  channels.length = donors.length = drafts.length = rewards.length = goals.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('pooled pledge creation on SQLite', () => {
  it('creates one immutable draft with its own funding on concurrent retries, before any comparison', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 975 },
    });
    donors.push(donor.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const plan = planPledge({
      pledge_amount_cents: 1000,
      selections: [],
      available_wallet_cents: 975,
    });
    const input = {
      draft_id,
      pledge_amount_cents: 1000,
      plan,
      items: [],
      channel_id: channel.id,
      walletDonorId: donor.id,
    };
    const [first, second] = await Promise.all([createPledge(input), createPledge(input)]);
    expect(second).toEqual(first);
    const retry = await createPledge({
      ...input,
      plan: { ...plan, new_money_cents: 999 },
      items: [{ kind: 'GOAL', target_id: 'deleted', amount_cents: 100 }],
    });
    expect(retry).toEqual(first);
    expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(1);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
    expect(await prisma.pendingPledge.findFirst({ where: { draft_id } })).toMatchObject({
      format: 'POOLED',
      held_wallet_cents: 950,
      wallet_hold_status: 'HELD',
      wallet_donor_id: donor.id,
      total_cents: 0,
      top_up_cents: 0,
      wallet_discount_cents: 0,
    });
    expect(first).not.toHaveProperty('total_cents');
    expect(first).not.toHaveProperty('top_up_cents');
  });

  it('rolls back a pledge and initial hold together on a late SQLite write failure', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 1000 },
    });
    donors.push(donor.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_pledge_hold BEFORE INSERT ON PendingPledge
      BEGIN SELECT RAISE(ABORT, 'reject pledge after hold'); END`);
    await expect(
      createPledge({
        draft_id,
        pledge_amount_cents: 1000,
        items: [],
        channel_id: channel.id,
        walletDonorId: donor.id,
        plan: planPledge({
          pledge_amount_cents: 1000,
          selections: [],
          available_wallet_cents: 1000,
        }),
      }),
    ).rejects.toThrow();
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 1000,
      balance_held_cents: 0,
    });
    expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(0);
  });

  it('rejects live category overage with 400, before comparing plans', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const goal = await prisma.fundGoal.create({ data: { title: 'Overdraw', target_cents: 5000 } });
    goals.push(goal.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    await expect(
      createPledge({
        draft_id,
        pledge_amount_cents: 1000,
        items: [{ kind: 'GOAL', target_id: goal.id, amount_cents: 1100 }],
        channel_id: channel.id,
        plan: planPledge({
          pledge_amount_cents: 1000,
          selections: [],
          available_wallet_cents: null,
        }),
      }),
    ).rejects.toMatchObject({ status: 400, plan: { overage_cents: { goal: 100 } } });
    expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(0);
  });

  it('corrects live prices and stock without storing anything until confirmed, then locks price/type', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const reward = await prisma.reward.create({
      data: { title: 'Shirt', type: 'PHYSICAL', cost_cents: 300, quantity_total: 1 },
    });
    rewards.push(reward.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const input = {
      draft_id,
      pledge_amount_cents: 1000,
      items: [{ kind: 'REWARD' as const, target_id: reward.id, quantity: 2 }],
      channel_id: channel.id,
    };
    const old = planPledge({
      pledge_amount_cents: 1000,
      available_wallet_cents: null,
      selections: [
        {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: 400,
          quantity: 2,
          unit_price_cents: 200,
          reward_type: 'DIGITAL',
          insertion_order: 0,
        },
      ],
    });
    await expect(createPledge({ ...input, plan: old })).rejects.toMatchObject({
      status: 409,
      plan: { requires_shipping: true, usage_cents: { reward: 300 } },
      items: [{ quantity: 1, amount_cents: 300 }],
    });
    expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(0);
    const confirmed = planPledge({
      pledge_amount_cents: 1000,
      available_wallet_cents: null,
      selections: [
        {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: 300,
          quantity: 1,
          unit_price_cents: 300,
          reward_type: 'PHYSICAL',
          insertion_order: 0,
        },
      ],
    });
    const result = await createPledge({ ...input, plan: confirmed });
    expect(result.items).toMatchObject([
      {
        amount_cents: 300,
        unit_price_cents: 300,
        confirmed_reward_type: 'PHYSICAL',
        source: 'donor',
      },
    ]);
    expect(result).toMatchObject({
      format: 'POOLED',
      pledge_amount_cents: 1000,
      plan: confirmed,
      new_money_cents: 1000,
    });
  });

  it('allows corrected surviving selections to be resubmitted without losing their insertion order', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const goal = await prisma.fundGoal.create({ data: { title: 'Survivor', target_cents: 5000 } });
    goals.push(goal.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const items = [
      { kind: 'GOAL' as const, target_id: 'removed', amount_cents: 100 },
      { kind: 'GOAL' as const, target_id: goal.id, amount_cents: 100 },
    ];
    const input = {
      draft_id,
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      items,
      plan: planPledge({
        pledge_amount_cents: 1000,
        available_wallet_cents: null,
        selections: items.map((item, insertion_order) => ({ ...item, insertion_order })),
      }),
    };
    const correction = await createPledge(input).then(
      () => {
        throw new Error('Expected a corrected review');
      },
      (error: unknown) => error as { status: number; plan: PledgePlan; items: PledgeItemInput[] },
    );
    expect(correction).toMatchObject({ status: 409, plan: { usage_cents: { goal: 100 } } });
    const confirmed = await createPledge({
      ...input,
      plan: correction.plan,
      items: correction.items,
    });
    expect(confirmed).toMatchObject({
      format: 'POOLED',
      plan: { selections: [{ target_id: goal.id, insertion_order: 1, reward_type: null }] },
    });
    const spec = yaml.load(
      readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8'),
    ) as {
      components: {
        schemas: {
          PlannedSelection: {
            required: string[];
            properties: { reward_type: { type: string; nullable: boolean; enum: unknown[] } };
          };
        };
      };
    };
    if (confirmed.format !== 'POOLED') throw new Error('Expected a pooled pledge');
    const selection = spec.components.schemas.PlannedSelection;
    expect(selection.required).toContain('reward_type');
    const rewardType = selection.properties.reward_type;
    expect(rewardType).toMatchObject({ type: 'string', nullable: true });
    // Focused enum acceptance checks, not full OpenAPI instance validation.
    expect(rewardType.enum).toContain(confirmed.plan.selections[0]!.reward_type);
    for (const value of ['DIGITAL', 'PHYSICAL', 'SHOUTOUT', 'CUSTOM'])
      expect(rewardType.enum).toContain(value);
    for (const value of ['null', 'INVALID']) expect(rewardType.enum).not.toContain(value);
  });

  it.each([
    { comment: 'x'.repeat(501), amount: 100, message: 'Comment exceeds maximum' },
    { display_name: 'x'.repeat(61), amount: 100, message: 'Display name exceeds maximum' },
    { amount: 99, message: 'Selection amount' },
    { amount: 100.5, message: 'Selection amount' },
  ])(
    'validates live text and donor selection cents ($message), without a pledge',
    async ({ comment, display_name, amount, message }) => {
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const goal = await prisma.fundGoal.create({
        data: { title: 'Validation', target_cents: 5000 },
      });
      goals.push(goal.id);
      const draft_id = crypto.randomUUID();
      drafts.push(draft_id);
      await expect(
        createPledge({
          draft_id,
          pledge_amount_cents: 1000,
          channel_id: channel.id,
          comment,
          display_name,
          items: [{ kind: 'GOAL', target_id: goal.id, amount_cents: amount }],
          plan: planPledge({
            pledge_amount_cents: 1000,
            selections: [
              { kind: 'GOAL', target_id: goal.id, amount_cents: 100, insertion_order: 0 },
            ],
            available_wallet_cents: null,
          }),
        }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
      expect(await prisma.pendingPledge.count({ where: { draft_id } })).toBe(0);
    },
  );

  it('filters blocked words with the transaction client rather than deadlocking on global Prisma', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const word = await prisma.blockedWord.create({
      data: { word: `blocked${crypto.randomUUID().replaceAll('-', '')}` },
    });
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    try {
      await expect(
        createPledge({
          draft_id,
          pledge_amount_cents: 1000,
          channel_id: channel.id,
          items: [],
          comment: word.word,
          plan: planPledge({
            pledge_amount_cents: 1000,
            selections: [],
            available_wallet_cents: null,
          }),
        }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('blocked word') });
    } finally {
      await prisma.blockedWord.delete({ where: { id: word.id } });
    }
  });

  it('does not use an email address as authority for Wallet funding', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 5000 },
    });
    donors.push(donor.id);
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const result = await createPledge({
      draft_id,
      email: donor.email,
      pledge_amount_cents: 1000,
      items: [],
      channel_id: channel.id,
      plan: planPledge({ pledge_amount_cents: 1000, selections: [], available_wallet_cents: null }),
    });
    expect(result).toMatchObject({ new_money_cents: 1000, wallet_applied_cents: 0 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 5000,
      balance_held_cents: 0,
    });
  });
  it('returns the corrected plan with no pledge or hold when available credit changed', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 975 },
    });
    donors.push(donor.id);
    const draft = crypto.randomUUID();
    drafts.push(draft);
    await expect(
      createPledge({
        channel_id: channel.id,
        items: [],
        draft_id: draft,
        pledge_amount_cents: 1000,
        walletDonorId: donor.id,
        plan: planPledge({
          pledge_amount_cents: 1000,
          selections: [],
          available_wallet_cents: null,
        }),
      }),
    ).rejects.toMatchObject({
      status: 409,
      plan: { wallet_applied_cents: 950, new_money_cents: 50 },
    });
    expect(await prisma.pendingPledge.count({ where: { draft_id: draft } })).toBe(0);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 975,
      balance_held_cents: 0,
    });
  });
});
