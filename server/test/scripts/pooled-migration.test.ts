import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
let dir: string;
let url: string;
let db: PrismaClient;

function deploy(schema: string, databaseUrl = url) {
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'pooled-migration-'));
  url = `file:${path.join(dir, 'history.db')}`;
  db = new PrismaClient({ datasourceUrl: url });
  // Build a real pre-pooled database using the released migration history.
  cpSync(path.join(serverDir, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
  const migrations = path.join(serverDir, 'prisma/migrations');
  for (const name of readdirSync(migrations)) {
    if (name === 'migration_lock.toml' || name <= '20260929101729_vote_contribution_donation') {
      cpSync(path.join(migrations, name), path.join(dir, 'migrations', name), { recursive: true });
    }
  }
  deploy(path.join(dir, 'schema.prisma'));
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO Donor (id, email, total_donated, balance_remaining, updated_at)
      VALUES ('donor', 'history@example.test', 9000, 321, 1000)`;
    await tx.$executeRaw`INSERT INTO Channel (id, name, slug, event_id, updated_at)
      VALUES ('channel', 'History', 'history', '00000000-0000-4000-8000-000000000001', 1000)`;
    for (const status of ['PENDING', 'COMPLETED', 'REFUNDED', 'CHARGEBACK']) {
      for (const kind of ['stripe', 'wallet']) {
        const id = `${kind}-${status}`;
        const externalId = kind === 'wallet' ? `wallet-${crypto.randomUUID()}` : `cs_${status}`;
        await tx.$executeRaw`INSERT INTO Donation (id, external_id, donor_id, amount_cents, status, channel_id, event_id)
          VALUES (${id}, ${externalId}, 'donor', 1000, ${status}, 'channel', '00000000-0000-4000-8000-000000000001')`;
      }
    }
    await tx.$executeRaw`INSERT INTO Reward (id, title, type, cost_cents, updated_at)
      VALUES ('physical', 'Shirt', 'PHYSICAL', 275, 1000)`;
    await tx.$executeRaw`INSERT INTO Poll (id, title, updated_at) VALUES ('poll', 'History poll', 1000)`;
    await tx.$executeRaw`INSERT INTO PollOption (id, poll_id, label) VALUES ('option', 'poll', 'Choice')`;
    await tx.$executeRaw`INSERT INTO FundGoal (id, title, target_cents, updated_at)
      VALUES ('goal', 'History goal', 5000, 1000)`;
    for (const [id, donationId, status] of [
      ['claim', 'stripe-REFUNDED', 'PENDING'],
      ['shipped', 'stripe-CHARGEBACK', 'FULFILLED'],
      ['unlinked', null, 'PENDING'],
      ['reversed', 'stripe-REFUNDED', 'REVERSED'],
    ]) {
      await tx.$executeRaw`INSERT INTO RewardClaim (id, reward_id, donor_id, donation_id, status, claim_data, updated_at)
        VALUES (${id}, 'physical', 'donor', ${donationId}, ${status}, '{"size":"M"}', 1000)`;
    }
    await tx.$executeRaw`INSERT INTO PollVote (id, poll_id, poll_option_id, donor_id, amount_cents, donation_id)
      VALUES ('vote', 'poll', 'option', 'donor', 125, 'stripe-REFUNDED'),
             ('unlinked-vote', 'poll', 'option', 'donor', 20, NULL)`;
    await tx.$executeRaw`INSERT INTO FundContribution (id, goal_id, donor_id, amount_cents, donation_id)
      VALUES ('contribution', 'goal', 'donor', 150, 'stripe-CHARGEBACK'),
             ('unlinked-contribution', 'goal', 'donor', 30, NULL)`;
    await tx.$executeRaw`INSERT INTO BalanceAdjustment
      (id, donor_id, amount_cents, balance_after_cents, type, reference_id)
      VALUES ('refund', 'donor', -1000, 321, 'REFUND', 'stripe-REFUNDED'),
             ('item-refund', 'donor', 275, 321, 'REFUND', 'reversed')`;
    await tx.$executeRaw`UPDATE Donation SET refund_id = 'refund' WHERE id = 'stripe-REFUNDED'`;
    for (const status of ['OPEN', 'FULFILLED', 'EXPIRED', 'CANCELLED']) {
      await tx.$executeRaw`INSERT INTO PendingPledge
        (id, pledge_token, total_cents, top_up_cents, wallet_discount_cents, status, requires_shipping,
         checkout_session_id, channel_id, comment, display_name, expires_at, updated_at)
        VALUES (${status}, ${`token-${status}`}, 900, 100, 50, ${status}, true,
          ${`session-${status}`}, 'channel', 'Keep me', 'Historical donor', 1000, 1000)`;
      await tx.$executeRaw`INSERT INTO PledgeItem (id, pledge_id, kind, target_id, amount_cents, quantity)
        VALUES (${`item-${status}`}, ${status}, 'REWARD', 'physical', 800, 2)`;
    }
    await tx.$executeRaw`INSERT INTO WebhookEndpoint (id, url, secret, event_types, updated_at)
      VALUES ('destination', 'https://example.test/hook', 'secret', '["donation.created"]', 1000)`;
  });
  await db.$disconnect();
  cpSync(path.join(dir, 'history.db'), path.join(dir, 'pre-change.db'));
  deploy(path.join(serverDir, 'prisma/schema.prisma'));
  db = new PrismaClient({ datasourceUrl: url });
}, 60_000);

afterEach(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('pooled accounting migration on populated SQLite', () => {
  it('rolls back schema and corrections together when a historical claim cannot be priced', async () => {
    const failureUrl = `file:${path.join(dir, 'pre-change.db')}`;
    const old = new PrismaClient({ datasourceUrl: `${failureUrl}?connection_limit=1` });
    try {
      // Corrupt history cannot be backfilled conservatively: do not invent a price.
      await old.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
      await old.$executeRaw`INSERT INTO RewardClaim (id, reward_id, donor_id, updated_at)
        VALUES ('orphan', 'missing-reward', 'donor', 1000)`;
      await old.$disconnect();
      cpSync(
        path.join(serverDir, 'prisma/migrations/20261012000000_pooled_accounting'),
        path.join(dir, 'migrations/20261012000000_pooled_accounting'),
        { recursive: true },
      );
      expect(() => deploy(path.join(dir, 'schema.prisma'), failureUrl)).toThrow();
      expect(
        await old.$queryRawUnsafe(
          "SELECT amount_cents FROM Donation WHERE id = 'wallet-COMPLETED'",
        ),
      ).toEqual([{ amount_cents: 1000 }]);
      expect(
        await old.$queryRawUnsafe("SELECT status FROM PendingPledge WHERE id = 'OPEN'"),
      ).toEqual([{ status: 'OPEN' }]);
      expect(
        await old.$queryRawUnsafe(
          "SELECT name FROM pragma_table_info('Donation') WHERE name = 'pledge_amount_cents'",
        ),
      ).toEqual([]);
      expect(
        await old.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name = 'PoolCredit'"),
      ).toEqual([]);
    } finally {
      await old.$disconnect();
    }
  });
  it('rejects ambiguous pledge shapes, unattributed moderator rows and untraceable credit', async () => {
    await expect(
      db.pendingPledge.create({
        data: {
          pledge_token: 'ambiguous',
          pledge_amount_cents: 500,
          expires_at: new Date('2030-01-01'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.pendingPledge.create({
        data: {
          pledge_token: 'missing-plan',
          format: 'POOLED',
          pledge_amount_cents: 500,
          expires_at: new Date('2030-01-01'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.pollVote.create({
        data: {
          poll_id: 'poll',
          poll_option_id: 'option',
          donor_id: 'donor',
          amount_cents: 50,
          source: 'moderator',
        },
      }),
    ).rejects.toThrow();
    const assigned = await db.fundContribution.create({
      data: {
        goal_id: 'goal',
        donor_id: 'donor',
        amount_cents: 50,
        source: 'moderator',
        allocated_by: 'staff',
        allocated_at: new Date(),
      },
    });
    expect(assigned.allocated_by).toBe('staff');
    await expect(
      db.poolCredit.create({
        data: {
          donation_id: 'stripe-COMPLETED',
          category: 'poll',
          amount_cents: 50,
          remaining_cents: 50,
          created_by: 'staff',
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.poolCredit.create({
        data: {
          donation_id: 'stripe-COMPLETED',
          category: 'reward',
          amount_cents: 50,
          remaining_cents: 51,
          source_claim_id: 'claim',
          created_by: 'staff',
        },
      }),
    ).rejects.toThrow();
    await db.reward.update({ where: { id: 'physical' }, data: { cost_cents: 900 } });
    expect((await db.rewardClaim.findUniqueOrThrow({ where: { id: 'claim' } })).amount_cents).toBe(
      275,
    );
  });
  it('retains category credit origins, redemption links and donor-scoped batch idempotency', async () => {
    await db.donation.create({
      data: {
        id: 'credit-donation',
        external_id: 'credit-source',
        donor_id: 'donor',
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        event_id: '00000000-0000-4000-8000-000000000001',
      },
    });
    await db.pollVote.create({
      data: {
        id: 'credit-vote',
        poll_id: 'poll',
        poll_option_id: 'option',
        donor_id: 'donor',
        donation_id: 'credit-donation',
        amount_cents: 50,
        source: 'auto',
        reversed_at: new Date(),
      },
    });
    const credit = await db.poolCredit.create({
      data: {
        donation_id: 'credit-donation',
        category: 'poll',
        amount_cents: 50,
        remaining_cents: 30,
        source_vote_id: 'credit-vote',
        created_by: 'admin',
      },
    });
    await expect(
      db.poolCredit.create({
        data: {
          donation_id: 'credit-donation',
          category: 'poll',
          amount_cents: 50,
          remaining_cents: 50,
          source_vote_id: 'credit-vote',
          created_by: 'admin',
        },
      }),
    ).rejects.toThrow();
    const batch = await db.poolCreditBatch.create({
      data: {
        donor_id: 'donor',
        event_id: '00000000-0000-4000-8000-000000000001',
        idempotency_key: 'apply-once',
        request_data: '{"poll":20}',
        result_data: '{"applied":20}',
      },
    });
    await expect(
      db.poolCreditBatch.create({
        data: {
          donor_id: 'donor',
          event_id: batch.event_id,
          idempotency_key: 'apply-once',
          request_data: '{"poll":20}',
        },
      }),
    ).rejects.toThrow();
    const vote = await db.pollVote.create({
      data: {
        poll_id: 'poll',
        poll_option_id: 'option',
        donor_id: 'donor',
        donation_id: 'credit-donation',
        amount_cents: 20,
      },
    });
    await db.poolCreditRedemption.create({
      data: { credit_id: credit.id, batch_id: batch.id, amount_cents: 20, vote_id: vote.id },
    });
    const saved = await db.poolCredit.findUniqueOrThrow({
      where: { id: credit.id },
      include: {
        donation: true,
        source_vote: true,
        redemptions: { include: { vote: true, batch: true } },
      },
    });
    expect(saved).toMatchObject({
      category: 'poll',
      remaining_cents: 30,
      donation: { pledge_amount_cents: 1000 },
      source_vote: { source: 'auto' },
      redemptions: [
        {
          amount_cents: 20,
          vote: { donation_id: 'credit-donation', source: 'donor' },
          batch: { idempotency_key: 'apply-once' },
        },
      ],
    });
    await db.donation.update({
      where: { id: 'credit-donation' },
      data: { wallet_credit_granted_cents: 200, failed_payment_wallet_credit_cents: 200 },
    });
    expect(
      (await db.donation.findUniqueOrThrow({ where: { id: 'credit-donation' } }))
        .wallet_credit_granted_cents,
    ).toBe(200);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('persists held funding, confirmed prices and serialized physical Payment refund history', async () => {
    const pledge = await db.pendingPledge.create({
      data: {
        id: 'pooled-pledge',
        pledge_token: 'pooled-token',
        format: 'POOLED',
        draft_id: 'draft',
        pledge_amount_cents: 1000,
        new_money_cents: 800,
        held_wallet_cents: 200,
        wallet_donor_id: 'donor',
        wallet_hold_status: 'HELD',
        confirmed_plan:
          '{"pledge_amount_cents":1000,"wallet_applied_cents":200,"new_money_cents":800}',
        expires_at: new Date('2030-01-01'),
        channel_id: 'channel',
        items: {
          create: {
            kind: 'REWARD',
            target_id: 'physical',
            amount_cents: 275,
            unit_price_cents: 275,
            confirmed_reward_type: 'PHYSICAL',
          },
        },
      },
      include: { items: true },
    });
    expect(pledge).toMatchObject({
      format: 'POOLED',
      pledge_amount_cents: 1000,
      held_wallet_cents: 200,
      total_cents: 0,
      items: [{ unit_price_cents: 275, confirmed_reward_type: 'PHYSICAL' }],
    });
    await expect(
      db.pendingPledge.create({
        data: {
          pledge_token: 'duplicate-draft',
          format: 'POOLED',
          draft_id: 'draft',
          pledge_amount_cents: 1000,
          new_money_cents: 1000,
          confirmed_plan: '{}',
          expires_at: new Date('2030-01-01'),
        },
      }),
    ).rejects.toThrow();
    await db.pendingPledge.update({
      where: { id: pledge.id },
      data: {
        status: 'CANCELLED',
        wallet_hold_status: 'RELEASED',
        wallet_released_at: new Date(),
        non_payment_confirmed_at: new Date(),
      },
    });
    const retry = await db.pendingPledge.create({
      data: {
        pledge_token: 'retry-draft',
        format: 'POOLED',
        draft_id: 'draft',
        pledge_amount_cents: 1000,
        new_money_cents: 1000,
        confirmed_plan: '{}',
        expires_at: new Date('2030-01-01'),
      },
    });
    expect(retry.draft_id).toBe('draft');
    await db.donation.create({
      data: {
        id: 'pooled',
        external_id: 'cs_pooled',
        donor_id: 'donor',
        channel_id: 'channel',
        event_id: '00000000-0000-4000-8000-000000000001',
        amount_cents: 800,
        pledge_amount_cents: 1000,
        wallet_applied_cents: 200,
        shipping_cents: 50,
        shipping_recorded_at: new Date(),
        payment_intent: 'pi_pooled',
      },
    });
    await db.rewardClaim.create({
      data: {
        id: 'cancelling',
        reward_id: 'physical',
        donor_id: 'donor',
        donation_id: 'pooled',
        amount_cents: 275,
        status: 'CANCELLING',
      },
    });
    const refund = await db.paymentRefund.create({
      data: {
        donation_id: 'pooled',
        claim_id: 'cancelling',
        item_cents: 275,
        shipping_cents: 50,
        created_by: 'admin',
        pool_shrink_data: '{"ended_targets":[]}',
      },
    });
    expect(refund.status).toBe('REQUESTED');
    await expect(
      db.paymentRefund.create({
        data: {
          donation_id: 'pooled',
          claim_id: 'cancelling',
          item_cents: 275,
          shipping_cents: 0,
          created_by: 'admin',
        },
      }),
    ).rejects.toThrow();
    await db.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        stripe_refund_id: 're_1',
        accepted_at: new Date(),
        failure_reason: 'declined',
      },
    });
    await db.balanceAdjustment.create({
      data: {
        donor_id: 'donor',
        donation_id: 'pooled',
        payment_refund_id: refund.id,
        amount_cents: 275,
        balance_after_cents: 596,
        type: 'FAILED_PAYMENT_REFUND',
        idempotency_key: `refund:${refund.id}`,
      },
    });
    const resolved = await db.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: 'RESOLVED',
        resolved_at: new Date(),
        resolved_by: 'admin',
        resolution: 'WALLET_CREDIT',
      },
      include: { wallet_adjustment: true },
    });
    expect(resolved.wallet_adjustment?.amount_cents).toBe(275);
    await db.event.update({
      where: { id: '00000000-0000-4000-8000-000000000001' },
      data: {
        ended_at: new Date(),
        ended_by: 'admin',
        end_audits: { create: { action: 'END', created_by: 'admin' } },
      },
    });
    await db.event.update({
      where: { id: '00000000-0000-4000-8000-000000000001' },
      data: {
        ended_at: null,
        end_undone_at: new Date(),
        end_undone_by: 'admin',
        end_audits: { create: { action: 'UNDO_END', created_by: 'admin' } },
      },
    });
    expect(await db.eventEndAudit.count()).toBe(2);
    await db.channelDefaultGoal.create({
      data: { channel_id: 'channel', goal_id: 'goal', position: 0 },
    });
    expect(
      (
        await db.channel.findUniqueOrThrow({
          where: { id: 'channel' },
          include: { default_goals: { orderBy: { position: 'asc' } } },
        })
      ).default_goals[0]?.goal_id,
    ).toBe('goal');
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('reports pre-change terminal donations, live linked allocations and applied adjustments without repairing them', async () => {
    const before = await db.$queryRawUnsafe('SELECT * FROM BalanceAdjustment ORDER BY id');
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(serverDir, 'scripts/pooled-migration-report.ts'),
        '--database-url',
        url,
      ],
      {
        cwd: serverDir,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'file:/must-not-use-live.db' },
      },
    );
    const report = JSON.parse(output);
    expect(report.counted_money_cents).toBe(2000);
    expect(report.legacy_terminal_donations.map((d: { id: string }) => d.id)).toEqual([
      'stripe-CHARGEBACK',
      'stripe-REFUNDED',
      'wallet-CHARGEBACK',
      'wallet-REFUNDED',
    ]);
    expect(report.legacy_terminal_donations[0]).toMatchObject({
      status: 'CHARGEBACK',
      live_allocations: {
        claims: [{ id: 'shipped', amount_cents: 275, status: 'FULFILLED' }],
        votes: [],
        contributions: [{ id: 'contribution', amount_cents: 150 }],
      },
    });
    expect(report.legacy_terminal_donations[1]).toMatchObject({
      status: 'REFUNDED',
      amount_cents: 1000,
      live_allocations: {
        claims: [{ id: 'claim', amount_cents: 275 }],
        votes: [{ id: 'vote', amount_cents: 125 }],
        contributions: [],
      },
      applied_adjustments: [
        { id: 'item-refund', amount_cents: 275 },
        { id: 'refund', amount_cents: -1000 },
      ],
    });
    expect(await db.$queryRawUnsafe('SELECT * FROM BalanceAdjustment ORDER BY id')).toEqual(before);
    expect(
      await db.$queryRawUnsafe("SELECT id, status FROM RewardClaim WHERE id = 'claim'"),
    ).toEqual([{ id: 'claim', status: 'PENDING' }]);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('preserves legacy history and only corrects wallet-only counted money', async () => {
    const donations = await db.$queryRawUnsafe<
      { id: string; amount_cents: number; pledge_amount_cents: number | null }[]
    >('SELECT id, amount_cents, pledge_amount_cents FROM Donation ORDER BY id');
    expect(donations).toHaveLength(8);
    expect(donations.every((d) => d.pledge_amount_cents === null)).toBe(true);
    expect(donations.filter((d) => d.id.startsWith('wallet')).map((d) => d.amount_cents)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(donations.filter((d) => d.id.startsWith('stripe')).map((d) => d.amount_cents)).toEqual([
      1000, 1000, 1000, 1000,
    ]);
    const counted = await db.$queryRawUnsafe<{ total: bigint }[]>(
      "SELECT SUM(amount_cents) AS total FROM Donation WHERE status IN ('COMPLETED', 'REFUNDED')",
    );
    expect(counted[0]?.total).toBe(2000n); // Before: 4000; counted wallet-only money: 2000.
    expect(
      await db.$queryRawUnsafe('SELECT balance_remaining, balance_held_cents FROM Donor'),
    ).toEqual([{ balance_remaining: 321, balance_held_cents: 0 }]);
    expect(await db.$queryRawUnsafe('SELECT amount_cents, claim_data FROM RewardClaim')).toEqual(
      Array.from({ length: 4 }, () => ({ amount_cents: 275, claim_data: '{"size":"M"}' })),
    );
    for (const table of ['PollVote', 'FundContribution']) {
      expect(
        await db.$queryRawUnsafe(`SELECT source, allocated_by, allocated_at FROM ${table}`),
      ).toEqual([
        { source: 'donor', allocated_by: null, allocated_at: null },
        { source: 'donor', allocated_by: null, allocated_at: null },
      ]);
    }
    expect(await db.$queryRawUnsafe('SELECT ended_at FROM Event')).toEqual([{ ended_at: null }]);
    expect(await db.$queryRawUnsafe('SELECT * FROM ChannelDefaultGoal')).toEqual([]);
    expect(await db.$queryRawUnsafe('SELECT event_types FROM WebhookEndpoint')).toEqual([
      { event_types: '["donation.created"]' },
    ]);
    const pledges = await db.$queryRawUnsafe<
      {
        id: string;
        status: string;
        format: string;
        pledge_amount_cents: number | null;
        total_cents: number;
        top_up_cents: number;
        wallet_discount_cents: number;
      }[]
    >(
      'SELECT id, status, format, pledge_amount_cents, total_cents, top_up_cents, wallet_discount_cents FROM PendingPledge ORDER BY id',
    );
    expect(pledges.map((p) => [p.id, p.status])).toEqual([
      ['CANCELLED', 'CANCELLED'],
      ['EXPIRED', 'EXPIRED'],
      ['FULFILLED', 'FULFILLED'],
      ['OPEN', 'EXPIRED'],
    ]);
    expect(
      pledges.every(
        (p) =>
          p.format === 'LEGACY' &&
          p.pledge_amount_cents === null &&
          p.total_cents === 900 &&
          p.top_up_cents === 100 &&
          p.wallet_discount_cents === 50,
      ),
    ).toBe(true);
    expect(await db.$queryRawUnsafe('SELECT amount_cents, quantity FROM PledgeItem')).toEqual(
      Array.from({ length: 4 }, () => ({ amount_cents: 800, quantity: 2 })),
    );
  });
});
