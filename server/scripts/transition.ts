// Operator-only interfaces. No environment loading, default database or network adapter.
import type { Prisma, PrismaClient } from '@prisma/client';
import { withWebhooks } from '../services/webhooks/outbox.js';

// Exact literal prefix and 8-4-4-4-12 hex UUID; same predicate as the unshipped backfill.
const walletIdGlob = `wallet-${[8, 4, 4, 4, 12].map((n) => '[0-9a-fA-F]'.repeat(n)).join('-')}`;
const historicalStatuses = ['COMPLETED', 'PENDING', 'REFUNDED', 'CHARGEBACK'];

export interface CheckoutFacts {
  id: string;
  status: string | null;
  payment_status: string;
  amount_total?: number | null;
  total_details?: { amount_shipping: number | null } | null;
}
export interface CheckoutAdapter {
  retrieve(id: string): Promise<CheckoutFacts>;
  expire(id: string): Promise<CheckoutFacts>;
}
export interface Bound {
  before: Date;
  limit: number;
  after?: string;
  apply: boolean;
}
function checkBound(bound: Bound) {
  if (
    !Number.isFinite(bound.before.getTime()) ||
    !Number.isInteger(bound.limit) ||
    bound.limit < 1 ||
    bound.limit > 1000
  )
    throw Error('An explicit before timestamp and limit from 1 to 1000 are required');
}
export interface Correction {
  id: string;
  external_id: string;
  before_cents: number;
  after_cents: number;
  shipping_cents: number | null;
  shipping_recorded_at: string | null;
  kind: 'shipping' | 'wallet';
}

/** Works on both pre-change and final schema. No donor emails or tokens in reports. */
export async function financialReport(db: PrismaClient | Prisma.TransactionClient) {
  const donors = await db.$queryRawUnsafe<
    { id: string; total_donated: number; counted_cents: bigint; received_cents: bigint }[]
  >(`
    SELECT d.id, d.total_donated,
      COALESCE(SUM(CASE WHEN n.status IN ('COMPLETED','REFUNDED') THEN n.amount_cents ELSE 0 END),0) AS counted_cents,
      COALESCE(SUM(CASE WHEN n.external_id NOT GLOB '${walletIdGlob}' THEN n.amount_cents ELSE 0 END),0) AS received_cents
    FROM Donor d LEFT JOIN Donation n ON n.donor_id = d.id GROUP BY d.id ORDER BY d.id`);
  const wallet = await db.$queryRawUnsafe<
    { id: string; external_id: string; amount_cents: number; status: string }[]
  >(
    `SELECT id, external_id, amount_cents, status FROM Donation WHERE external_id GLOB '${walletIdGlob}' ORDER BY id`,
  );
  return {
    counted_money_cents: donors.reduce((sum, d) => sum + Number(d.counted_cents), 0),
    // Receipt history spans statuses; it is NOT the charity's counted-money total.
    donors: donors.map((d) => ({
      ...d,
      counted_cents: Number(d.counted_cents),
      received_cents: Number(d.received_cents),
    })),
    wallet,
  };
}

export async function correctShipping(db: PrismaClient, stripe: CheckoutAdapter, bound: Bound) {
  checkBound(bound);
  // Historical SQLite DEFAULT CURRENT_TIMESTAMP rows use text; Prisma-created rows use ms.
  // A Prisma date predicate would silently omit the text rows this tool is meant to fix.
  const page = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM Donation WHERE substr(external_id,1,3) = 'cs_'
      AND julianday(CASE WHEN typeof(created_at) IN ('integer','real') THEN created_at / 1000.0 ELSE created_at END,
        CASE WHEN typeof(created_at) IN ('integer','real') THEN 'unixepoch' ELSE '+0 days' END) <= julianday(?)
      AND id > ? ORDER BY id LIMIT ?`,
    bound.before.toISOString(),
    bound.after ?? '',
    bound.limit + 1,
  );
  const candidates = await db.donation.findMany({
    where: { id: { in: page.map((row) => row.id) } },
    orderBy: { id: 'asc' },
  });
  // ALL external I/O precedes the write transaction. Missing/ambiguous facts are never guessed.
  const facts = new Map<string, CheckoutFacts>();
  for (const d of candidates.slice(0, bound.limit)) {
    if (
      d.shipping_cents !== null ||
      d.pledge_amount_cents !== null ||
      !historicalStatuses.includes(d.status)
    )
      continue;
    try {
      facts.set(d.id, await stripe.retrieve(d.external_id));
    } catch {
      /* reported UNKNOWN */
    }
  }
  return db.$transaction(async (tx) => {
    if (bound.apply) await tx.$executeRaw`UPDATE Donation SET id = id WHERE 0`;
    const before = await financialReport(tx);
    const rows: { id: string; outcome: string }[] = [];
    const corrected: Correction[] = [];
    for (const original of candidates.slice(0, bound.limit)) {
      const d = await tx.donation.findUniqueOrThrow({ where: { id: original.id } });
      let outcome = 'UNKNOWN';
      if (d.shipping_cents !== null) outcome = 'ALREADY_RECORDED';
      else if (d.pledge_amount_cents !== null) outcome = 'POOLED_MANUAL_REVIEW';
      else if (!historicalStatuses.includes(d.status)) outcome = 'STATUS_MANUAL_REVIEW';
      else if (
        d.external_id !== original.external_id ||
        d.donor_id !== original.donor_id ||
        d.status !== original.status ||
        d.amount_cents !== original.amount_cents
      )
        outcome = 'CHANGED_MANUAL_REVIEW';
      else {
        const f = facts.get(d.id),
          shipping = f?.total_details?.amount_shipping;
        if (
          f?.id === d.external_id &&
          f.status === 'complete' &&
          f.payment_status === 'paid' &&
          f.amount_total === d.amount_cents &&
          typeof shipping === 'number' &&
          Number.isSafeInteger(shipping) &&
          shipping >= 0 &&
          shipping <= d.amount_cents
        ) {
          // total_donated records received new money, independently of current status.
          // Prove that representation from the transaction's full receipt snapshot;
          // never normalize a historical mismatch to counted money (#163).
          const donor = before.donors.find((row) => row.id === d.donor_id);
          if (
            shipping > 0 &&
            (!donor ||
              !Number.isSafeInteger(donor.received_cents) ||
              donor.total_donated !== donor.received_cents ||
              donor.total_donated < shipping)
          ) {
            rows.push({ id: d.id, outcome: 'DONOR_TOTAL_MANUAL_REVIEW' });
            continue;
          }
          const recorded = new Date();
          const correction: Correction = {
            id: d.id,
            external_id: d.external_id,
            before_cents: d.amount_cents,
            after_cents: d.amount_cents - shipping,
            shipping_cents: shipping,
            shipping_recorded_at: recorded.toISOString(),
            kind: 'shipping',
          };
          if (bound.apply) {
            await tx.donation.update({
              where: { id: d.id },
              data: {
                amount_cents: correction.after_cents,
                shipping_cents: shipping,
                shipping_recorded_at: recorded,
              },
            });
            if (shipping > 0)
              await tx.donor.update({
                where: { id: d.donor_id },
                data: { total_donated: { decrement: shipping } },
              });
          }
          if (shipping > 0) corrected.push(correction);
          outcome = bound.apply ? 'CORRECTED' : 'WOULD_CORRECT';
        }
      }
      rows.push({ id: d.id, outcome });
    }
    return {
      operation: 'shipping',
      apply: bound.apply,
      before: bound.before.toISOString(),
      rows,
      corrected,
      financial_before: before,
      financial_after: await financialReport(tx),
      next_after: candidates.length > bound.limit ? candidates[bound.limit - 1]!.id : null,
    };
  });
}

export async function publishCorrections(
  db: PrismaClient,
  corrections: Correction[],
  apply: boolean,
  bindingAck: boolean,
) {
  if (apply && !bindingAck) throw Error('Explicit overlay binding acknowledgement required');
  if (corrections.length > 1000) throw Error('At most 1000 corrections per publication');
  return withWebhooks(
    async (tx, _emit, publisher) => {
      if (apply) await tx.$executeRaw`UPDATE Donation SET id = id WHERE 0`;
      const ids = new Set<string>();
      for (const c of corrections) {
        const d = await tx.donation.findUniqueOrThrow({ where: { id: c.id } });
        const wallet =
          c.kind === 'wallet' &&
          c.after_cents === 0 &&
          (
            await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM Donation WHERE id = ${d.id} AND external_id GLOB ${walletIdGlob}
          `
          ).length === 1;
        const shipping =
          c.kind === 'shipping' &&
          c.external_id.startsWith('cs_') &&
          c.shipping_cents !== null &&
          c.shipping_cents > 0 &&
          c.before_cents - c.after_cents === c.shipping_cents &&
          d.shipping_cents === c.shipping_cents &&
          d.shipping_recorded_at?.toISOString() === c.shipping_recorded_at;
        if (
          d.pledge_amount_cents !== null ||
          c.before_cents <= c.after_cents ||
          d.external_id !== c.external_id ||
          d.amount_cents !== c.after_cents ||
          !(wallet || shipping)
        )
          throw Error(`Unproved or stale correction: ${c.id}`);
        ids.add(c.id);
      }
      if (apply) await publisher.forceForTransition([...ids]);
      return { operation: 'publish', apply, donation_ids: [...ids] };
    },
    { database: db, dispatch: false },
  );
}

export async function drainCheckouts(db: PrismaClient, stripe: CheckoutAdapter, bound: Bound) {
  checkBound(bound);
  // Raw projection deliberately also works BEFORE the pooled migration adds format.
  const columns = await db.$queryRawUnsafe<{ name: string }[]>(
    "PRAGMA table_info('PendingPledge')",
  );
  const legacy = columns.some((c) => c.name === 'format') ? " AND format = 'LEGACY'" : '';
  const pledges = await db.$queryRawUnsafe<{ id: string; checkout_session_id: string | null }[]>(
    `SELECT id, checkout_session_id FROM PendingPledge WHERE status = 'OPEN'${legacy}
      AND julianday(CASE WHEN typeof(created_at) IN ('integer','real') THEN created_at / 1000.0 ELSE created_at END,
        CASE WHEN typeof(created_at) IN ('integer','real') THEN 'unixepoch' ELSE '+0 days' END) <= julianday(?)
      AND id > ? ORDER BY id LIMIT ?`,
    bound.before.toISOString(),
    bound.after ?? '',
    bound.limit + 1,
  );
  const rows: { id: string; session_id: string | null; outcome: string }[] = [];
  for (const pledge of pledges.slice(0, bound.limit)) {
    const id = pledge.checkout_session_id;
    let outcome = 'UNKNOWN';
    if (id) {
      try {
        let facts = await stripe.retrieve(id);
        if (facts.id !== id) throw Error('Session mismatch');
        if (facts.status === 'open' && facts.payment_status === 'unpaid' && bound.apply) {
          // Expiry can race payment or time out. Retrieve the same Session after ANY outcome.
          try {
            await stripe.expire(id);
          } catch {
            /* retain uncertainty until retrieval */
          }
          facts = await stripe.retrieve(id);
          if (facts.id !== id) throw Error('Session mismatch');
          outcome = facts.status === 'open' ? 'STILL_OPEN' : 'UNKNOWN';
        } else if (facts.status === 'open' && facts.payment_status === 'unpaid')
          outcome = 'WOULD_EXPIRE';
        if (facts.status === 'complete' && facts.payment_status === 'paid') outcome = 'PAID';
        else if (facts.status === 'complete' && facts.payment_status === 'unpaid')
          outcome = 'COMPLETE_UNPAID';
        else if (facts.status === 'expired' && facts.payment_status === 'unpaid')
          outcome = 'EXPIRED';
      } catch {
        outcome = 'UNKNOWN';
      }
    }
    rows.push({ id: pledge.id, session_id: id, outcome });
  }
  return {
    operation: 'drain',
    apply: bound.apply,
    before: bound.before.toISOString(),
    rows,
    next_after: pledges.length > bound.limit ? rows.at(-1)!.id : null,
  };
}
