import type { PledgeItem, Prisma } from '@prisma/client';

/** Confirmed initial reward type wins; historical rows fall back to the catalog. */
export function confirmedRewardType(
  claim: { reward_id: string; reward: { type: string } },
  items: readonly Pick<PledgeItem, 'kind' | 'target_id' | 'confirmed_reward_type'>[] | undefined,
): string {
  return (
    items?.find((item) => item.kind === 'REWARD' && item.target_id === claim.reward_id)
      ?.confirmed_reward_type ?? claim.reward.type
  );
}

/** Redemptions are canonical funding, even when a whole entitlement has donation_id=null. */
export async function readRewardFundingTx(
  tx: Prisma.TransactionClient,
  claim: { id: string; donation_id: string | null; amount_cents: number },
) {
  const rows = await tx.poolCreditRedemption.findMany({
    where: { claim_id: claim.id },
    select: {
      id: true,
      credit_id: true,
      amount_cents: true,
      reduced_cents: true,
      credit: { select: { donation_id: true, donation: { select: { created_at: true } } } },
    },
  });
  const amounts = new Map<string, number>();
  for (const row of rows)
    amounts.set(
      row.credit.donation_id,
      (amounts.get(row.credit.donation_id) ?? 0) + row.amount_cents - row.reduced_cents,
    );
  const ordered = [...rows].sort(
    (a, b) =>
      a.credit.donation.created_at.getTime() - b.credit.donation.created_at.getTime() ||
      a.credit.donation_id.localeCompare(b.credit.donation_id),
  );
  return {
    redemption_backed: rows.length > 0,
    components: rows.map(({ credit, ...row }) => ({
      ...row,
      effective_cents: row.amount_cents - row.reduced_cents,
      donation_id: credit.donation_id,
    })),
    donation_ids: rows.length
      ? [...new Set(ordered.map((row) => row.credit.donation_id))]
      : claim.donation_id
        ? [claim.donation_id]
        : [],
    carrier_donation_id: ordered[0]?.credit.donation_id ?? claim.donation_id,
    source_cents: rows.length
      ? amounts
      : new Map(claim.donation_id ? [[claim.donation_id, claim.amount_cents]] : []),
  };
}

/** Source-local financial projection; entitlement/stock/status still belong to ONE claim. */
export async function readCreditRewardAllocationsTx(
  tx: Prisma.TransactionClient,
  donationId: string,
) {
  const claims = await tx.rewardClaim.findMany({
    where: {
      reversed_at: null,
      status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] },
      credit_redemptions: { some: { credit: { donation_id: donationId } } },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true, donation_id: true, reward_id: true, amount_cents: true, status: true },
  });
  const result = [];
  for (const claim of claims) {
    const funding = await readRewardFundingTx(tx, claim);
    result.push({
      id: claim.id,
      reward_id: claim.reward_id,
      status: claim.status,
      source: 'donor' as const,
      amount_cents: funding.source_cents.get(donationId)!,
      entitlement_amount_cents: claim.amount_cents,
      carrier_donation_id: funding.carrier_donation_id!,
    });
  }
  return result;
}
