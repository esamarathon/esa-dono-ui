import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';

it('migrates populated immutable credit-consumption history with a checked zero effective reduction and no money/backfill changes', async () => {
  const server = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'payment-refund-migration-'));
  const url = `file:${path.join(dir, 'history.db')}`;
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  let db = new PrismaClient({ datasourceUrl: url });
  const deploy = (schema: string) =>
    execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], {
      cwd: server,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  try {
    cpSync(path.join(server, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
    const migrations = path.join(server, 'prisma/migrations');
    for (const name of readdirSync(migrations))
      if (name === 'migration_lock.toml' || name <= '20261013000000_checkout_uncertainty')
        cpSync(path.join(migrations, name), path.join(dir, 'migrations', name), {
          recursive: true,
        });
    deploy(path.join(dir, 'schema.prisma'));
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO Donor (id,email,total_donated,balance_remaining,updated_at) VALUES ('donor','fixture@invalid',1000,37,1000)`;
      await tx.$executeRaw`INSERT INTO Donation (id,external_id,donor_id,amount_cents,pledge_amount_cents,shipping_cents) VALUES ('donation','cs_history','donor',1000,1000,200)`;
      await tx.$executeRaw`INSERT INTO Reward (id,title,type,cost_cents,quantity_claimed,updated_at) VALUES ('reward','Digital','DIGITAL',50,1,1000)`;
      await tx.$executeRaw`INSERT INTO RewardClaim (id,reward_id,donor_id,donation_id,amount_cents,status,reversed_at,updated_at) VALUES ('origin','reward','donor','donation',70,'REVERSED',1000,1000), ('target','reward','donor',NULL,50,'PENDING',NULL,1000)`;
      await tx.$executeRaw`INSERT INTO PoolCredit (id,donation_id,category,amount_cents,remaining_cents,source_claim_id,created_by) VALUES ('credit','donation','reward',70,20,'origin','admin')`;
      await tx.$executeRaw`INSERT INTO PoolCreditBatch (id,donor_id,event_id,idempotency_key,request_data,result_data) VALUES ('batch','donor','00000000-0000-4000-8000-000000000001','key','{}','{}')`;
      await tx.$executeRaw`INSERT INTO PoolCreditRedemption (id,credit_id,batch_id,amount_cents,claim_id) VALUES ('redemption','credit','batch',50,'target')`;
    });
    const money = await db.donation.findMany();
    const donors = await db.donor.findMany();
    const claims = await db.rewardClaim.findMany();
    const credits = await db.poolCredit.findMany();
    await db.$disconnect();
    deploy(path.join(server, 'prisma/schema.prisma'));
    db = new PrismaClient({ datasourceUrl: url });
    expect(await db.donation.findMany()).toEqual(money);
    expect(await db.donor.findMany()).toEqual(donors);
    expect(await db.rewardClaim.findMany()).toEqual(claims);
    expect(await db.poolCredit.findMany()).toEqual(credits);
    expect(await db.poolCreditRedemption.findMany()).toMatchObject([
      {
        id: 'redemption',
        amount_cents: 50,
        reduced_cents: 0,
        claim_id: 'target',
        credit_id: 'credit',
        batch_id: 'batch',
      },
    ]);
    await db.poolCreditRedemption.update({
      where: { id: 'redemption' },
      data: { reduced_cents: 20 },
    });
    expect(
      await db.poolCreditRedemption.findUniqueOrThrow({ where: { id: 'redemption' } }),
    ).toMatchObject({ amount_cents: 50, reduced_cents: 20 });
    for (const invalid of [-1, 51])
      await expect(
        db.poolCreditRedemption.update({
          where: { id: 'redemption' },
          data: { reduced_cents: invalid },
        }),
      ).rejects.toThrow();
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
