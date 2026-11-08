import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_ID } from '../helpers/fixtures.js';

// ADR-0012: the migration gives every incentive exactly one Event, or changes nothing.
const server = fileURLToPath(new URL('../../', import.meta.url));
const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const PREVIOUS = '20261014000000_payment_refund_effective_funding';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A database at the previous migration, plus a deploy of the full history. */
async function previousSchemaDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shared-incentive-migration-'));
  const url = `file:${path.join(dir, 'history.db')}`;
  const deploy = (schema: string) =>
    execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], {
      cwd: server,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  cpSync(path.join(server, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
  const migrations = path.join(server, 'prisma/migrations');
  for (const name of readdirSync(migrations))
    if (name === 'migration_lock.toml' || name <= PREVIOUS)
      cpSync(path.join(migrations, name), path.join(dir, 'migrations', name), { recursive: true });
  deploy(path.join(dir, 'schema.prisma'));
  const db = new PrismaClient({ datasourceUrl: url });
  cleanups.push(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, url, migrate: () => deploy(path.join(server, 'prisma/schema.prisma')) };
}

async function insertEvents(db: PrismaClient, ids: string[]) {
  for (const id of ids)
    await db.$executeRawUnsafe(
      `INSERT INTO Event (id,name,slug,updated_at) VALUES ('${id}','${id}','${id}',1000)`,
    );
}

const incentiveEvents = (db: PrismaClient) =>
  db.$queryRawUnsafe<Array<{ id: string; event_id: string }>>(
    `SELECT id, event_id FROM Reward UNION ALL SELECT id, event_id FROM Poll
     UNION ALL SELECT id, event_id FROM FundGoal UNION ALL SELECT id, event_id FROM Auction
     ORDER BY id`,
  );

describe('shared incentive Event migration', () => {
  it('assigns the Channel Event, the only Event, or the one Event with allocations', async () => {
    const { db, url, migrate } = await previousSchemaDatabase();
    await insertEvents(db, ['event-a', 'event-b']);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO Channel (id,name,slug,event_id,updated_at) VALUES ('channel-b','B','channel-b','event-b',1000)`;
      await tx.$executeRaw`INSERT INTO Donor (id,email,updated_at) VALUES ('donor','fixture@invalid',1000)`;
      await tx.$executeRaw`INSERT INTO Donation (id,external_id,donor_id,amount_cents,event_id,channel_id) VALUES ('donation-a','cs_a','donor',1000,'event-a',NULL), ('donation-b','cs_b','donor',1000,'event-b','channel-b')`;
      // Channel-owned: its Channel's Event, even with allocations elsewhere.
      await tx.$executeRaw`INSERT INTO Reward (id,title,type,cost_cents,channel_id,updated_at) VALUES ('reward-channel','Own','DIGITAL',100,'channel-b',1000)`;
      await tx.$executeRaw`INSERT INTO RewardClaim (id,reward_id,donor_id,donation_id,updated_at) VALUES ('claim-own','reward-channel','donor','donation-a',1000)`;
      // Shared with direct allocations in one Event only.
      await tx.$executeRaw`INSERT INTO Reward (id,title,type,cost_cents,updated_at) VALUES ('reward-shared','Shared','DIGITAL',100,1000)`;
      await tx.$executeRaw`INSERT INTO RewardClaim (id,reward_id,donor_id,donation_id,updated_at) VALUES ('claim-1','reward-shared','donor','donation-a',1000), ('claim-2','reward-shared','donor','donation-a',1000)`;
      await tx.$executeRaw`INSERT INTO Poll (id,title,updated_at) VALUES ('poll-shared','Shared poll',1000)`;
      await tx.$executeRaw`INSERT INTO PollOption (id,poll_id,label) VALUES ('option','poll-shared','A')`;
      await tx.$executeRaw`INSERT INTO PollVote (id,poll_id,poll_option_id,donor_id,donation_id,amount_cents) VALUES ('vote','poll-shared','option','donor','donation-b',100)`;
      // Shared goal funded only through a Pool credit batch of event-b.
      await tx.$executeRaw`INSERT INTO FundGoal (id,title,target_cents,updated_at) VALUES ('goal-shared','Shared goal',1000,1000)`;
      await tx.$executeRaw`INSERT INTO FundContribution (id,goal_id,donor_id,donation_id,amount_cents) VALUES ('origin','goal-shared','donor',NULL,100), ('spent','goal-shared','donor',NULL,50)`;
      await tx.$executeRaw`INSERT INTO PoolCredit (id,donation_id,category,amount_cents,remaining_cents,source_contribution_id,created_by) VALUES ('credit','donation-b','goal',100,50,'origin','admin')`;
      await tx.$executeRaw`INSERT INTO PoolCreditBatch (id,donor_id,event_id,idempotency_key,request_data) VALUES ('batch','donor','event-b','key','{}')`;
      await tx.$executeRaw`INSERT INTO PoolCreditRedemption (id,credit_id,batch_id,amount_cents,contribution_id) VALUES ('redemption','credit','batch',50,'spent')`;
      await tx.$executeRaw`INSERT INTO Auction (id,title,type,starting_price_cents,min_increment_cents,ends_at,channel_id,updated_at) VALUES ('auction-channel','Auction','DIGITAL',100,10,1000,'channel-b',1000)`;
    });
    const claims = await db.rewardClaim.findMany({ orderBy: { id: 'asc' } });
    await db.$disconnect();

    migrate();
    const after = new PrismaClient({ datasourceUrl: url });
    cleanups.push(() => after.$disconnect());
    expect(await incentiveEvents(after)).toEqual([
      { id: 'auction-channel', event_id: 'event-b' },
      { id: 'goal-shared', event_id: 'event-b' },
      { id: 'poll-shared', event_id: 'event-b' },
      { id: 'reward-channel', event_id: 'event-b' },
      { id: 'reward-shared', event_id: 'event-a' },
    ]);
    expect(await after.rewardClaim.findMany({ orderBy: { id: 'asc' } })).toEqual(claims);
    expect(await after.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(
      await after.$queryRawUnsafe(
        `SELECT name FROM sqlite_temp_master WHERE name = '_IncentiveEvent'`,
      ),
    ).toEqual([]);
    // The database keeps the invariant even for writes outside the lifecycle
    // (raw SQL: the Prisma client reports trigger aborts as a generic P2003).
    await expect(
      after.$executeRawUnsafe(
        `INSERT INTO Reward (id,title,type,cost_cents,channel_id,event_id,updated_at) VALUES ('wrong','Wrong','DIGITAL',100,'channel-b','event-a',1000)`,
      ),
    ).rejects.toThrow(/event_id must be the Event of channel_id/);
    await expect(
      after.fundGoal.update({ where: { id: 'goal-shared' }, data: { channel_id: 'channel-b' } }),
    ).resolves.toMatchObject({ channel_id: 'channel-b', event_id: 'event-b' });
    await expect(
      after.$executeRawUnsafe(`UPDATE Channel SET event_id = 'event-a' WHERE id = 'channel-b'`),
    ).rejects.toThrow(/A Channel with incentives cannot move to another Event/);
    await after.channel.create({
      data: { id: 'channel-empty', name: 'Empty', slug: 'channel-empty', event_id: 'event-b' },
    });
    await expect(
      after.channel.update({ where: { id: 'channel-empty' }, data: { event_id: 'event-a' } }),
    ).resolves.toMatchObject({ event_id: 'event-a' });
  }, 60_000);

  it('assigns the only Event to a shared incentive without allocations', async () => {
    // Migration 20260928211407 already created the default Event: it is the only one.
    const { db, url, migrate } = await previousSchemaDatabase();
    await db.$executeRaw`INSERT INTO FundGoal (id,title,target_cents,updated_at) VALUES ('goal','Goal',1000,1000)`;
    await db.$disconnect();

    migrate();
    const after = new PrismaClient({ datasourceUrl: url });
    cleanups.push(() => after.$disconnect());
    expect(await incentiveEvents(after)).toEqual([{ id: 'goal', event_id: DEFAULT_EVENT_ID }]);
  }, 60_000);

  it('fails and changes nothing when a shared incentive has no single Event', async () => {
    const { db, url, migrate } = await previousSchemaDatabase();
    await insertEvents(db, ['event-a', 'event-b']);
    await db.$executeRaw`INSERT INTO Channel (id,name,slug,event_id,updated_at) VALUES ('channel-a','A','channel-a','event-a',1000)`;
    // Migrated first in the rebuild order, so a later failure must roll it back.
    await db.$executeRaw`INSERT INTO Auction (id,title,type,starting_price_cents,min_increment_cents,ends_at,channel_id,updated_at) VALUES ('auction','Auction','DIGITAL',100,10,1000,'channel-a',1000)`;
    await db.$executeRaw`INSERT INTO Reward (id,title,type,cost_cents,updated_at) VALUES ('orphan','Shared','DIGITAL',100,1000)`;
    const before = await db.$queryRawUnsafe(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('Reward','Poll','FundGoal','Auction') ORDER BY name`,
    );
    await db.$disconnect();

    expect(migrate).toThrow(/NOT NULL constraint failed: new_Reward\.event_id/);
    const after = new PrismaClient({ datasourceUrl: url });
    cleanups.push(() => after.$disconnect());
    expect(
      await after.$queryRawUnsafe(
        `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('Reward','Poll','FundGoal','Auction') ORDER BY name`,
      ),
    ).toEqual(before);
    expect(
      await after.$queryRawUnsafe(
        `SELECT id, channel_id FROM Auction UNION ALL SELECT id, channel_id FROM Reward ORDER BY id`,
      ),
    ).toEqual([
      { id: 'auction', channel_id: 'channel-a' },
      { id: 'orphan', channel_id: null },
    ]);
  }, 60_000);
});
