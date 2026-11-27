import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';

type Tx = Prisma.TransactionClient;

export type AdjustmentType = 'REFUND' | 'FREEZE_ZERO' | 'MANUAL' | 'CHARGEBACK' | 'WALLET_REFUND';

/** Balance and audit row must use the same transaction, including the balance-after snapshot. */
export async function adjustWalletTx(
  tx: Tx,
  donorId: string,
  amountCents: number,
  type: AdjustmentType,
  reason: string | null,
  actor: string,
  referenceId: string | null = null,
  donationId: string | null = null,
) {
  const donor = await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { increment: amountCents } },
  });
  return tx.balanceAdjustment.create({
    data: {
      donor_id: donorId,
      amount_cents: amountCents,
      balance_after_cents: donor.balance_remaining,
      type,
      reason,
      reference_id: referenceId,
      donation_id: donationId,
      created_by: actor,
    },
  });
}

export async function sweepWalletCreditsTx(
  tx: Tx,
  where: Prisma.DonorWhereInput,
  confirm: boolean,
  actor: string,
) {
  const donors = await tx.donor.findMany({
    where,
    select: {
      id: true,
      balance_remaining: true,
      donations: { orderBy: { created_at: 'desc' }, take: 1, select: { donor_name: true } },
    },
  });
  const totalCents = donors.reduce((sum, donor) => sum + donor.balance_remaining, 0);
  if (!confirm) {
    return {
      preview: true,
      donor_count: donors.length,
      total_cents: totalCents,
      sample: donors.slice(0, 10).map((donor) => ({
        id: donor.id,
        balance_remaining: donor.balance_remaining,
        donor_name: donor.donations[0]?.donor_name ?? null,
      })),
    };
  }
  for (const donor of donors) {
    const displayName = donor.donations[0]?.donor_name || 'Anonymous';
    await adjustWalletTx(
      tx,
      donor.id,
      -donor.balance_remaining,
      'FREEZE_ZERO',
      `Bulk credit sweep (${displayName})`,
      actor,
    );
  }
  return { success: true, donor_count: donors.length, total_cents: totalCents };
}

export async function adjustWalletCreditTx(
  tx: Tx,
  donorId: string,
  cents: number,
  type: AdjustmentType,
  reason: string | undefined,
  actor: string,
) {
  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor) throw httpError(404, 'Donor not found');
  if (donor.balance_remaining + cents < 0) {
    throw httpError(400, 'Adjustment would result in negative balance');
  }
  const adjustment = await adjustWalletTx(tx, donorId, cents, type, reason || null, actor);
  return {
    success: true,
    balance_before: donor.balance_remaining,
    balance_after: adjustment.balance_after_cents,
    adjustment: cents,
  };
}
