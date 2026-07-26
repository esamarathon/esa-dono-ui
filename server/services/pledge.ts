import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { MIN_SPEND_CENTS } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { claimRewardTx, votePollTx, contributeGoalTx, proposeCustomEntryTx } from './spend.js';
import { checkBlockedWords } from './blockedWords.js';
import { PLEDGE_TTL_MS } from '../config.js';

interface PledgeItemInput {
  kind: string;
  target_id: string;
  amount_cents?: number;
  poll_id?: string | null;
  data?: unknown;
}

interface CreatePledgeInput {
  email?: string | null;
  items: PledgeItemInput[];
}

/**
 * Create a pending pledge from cart items.
 * Validates each item against live state, computes total, persists.
 * Returns { pledge_token, total_cents, donate_url }.
 */
export async function createPledge({ email, items }: CreatePledgeInput) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one item required'), { status: 400 });
  }

  // Validate all items against live data
  let totalCents = 0;
  for (const item of items) {
    const { kind, target_id, amount_cents, poll_id } = item;

    if (!['REWARD', 'POLL_VOTE', 'GOAL', 'POLL_CUSTOM'].includes(kind)) {
      throw Object.assign(new Error(`Invalid item kind: ${kind}`), { status: 400 });
    }

    if (kind === 'REWARD') {
      const reward = await prisma.reward.findUnique({ where: { id: target_id } });
      if (!reward || !reward.is_active) {
        throw Object.assign(new Error(`Reward not found: ${target_id}`), { status: 404 });
      }
      if (reward.quantity_total !== null && reward.quantity_claimed >= reward.quantity_total) {
        throw Object.assign(new Error(`Reward sold out: ${reward.title}`), { status: 400 });
      }
      totalCents += reward.cost_cents;
    } else if (kind === 'POLL_VOTE') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(new Error(`POLL_VOTE amount_cents (min ${MIN_SPEND_CENTS}) required`), {
          status: 400,
        });
      }
      if (!poll_id) {
        throw Object.assign(new Error('POLL_VOTE requires poll_id'), { status: 400 });
      }
      const poll = await prisma.poll.findUnique({ where: { id: poll_id } });
      if (!poll || !poll.is_active) {
        throw Object.assign(new Error(`Poll not found or inactive: ${poll_id}`), { status: 404 });
      }
      if (poll.ends_at && new Date() > poll.ends_at) {
        throw Object.assign(new Error(`Poll has ended: ${poll.title}`), { status: 400 });
      }
      const option = await prisma.pollOption.findUnique({ where: { id: target_id } });
      if (!option || option.poll_id !== poll_id) {
        throw Object.assign(new Error(`Option not found: ${target_id}`), { status: 404 });
      }
      totalCents += amount_cents!;
    } else if (kind === 'GOAL') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(new Error(`GOAL amount_cents (min ${MIN_SPEND_CENTS}) required`), {
          status: 400,
        });
      }
      const goal = await prisma.fundGoal.findUnique({ where: { id: target_id } });
      if (!goal || !goal.is_active || goal.is_complete) {
        throw Object.assign(new Error(`Goal not found, inactive, or complete: ${target_id}`), {
          status: 404,
        });
      }
      totalCents += amount_cents!;
    } else if (kind === 'POLL_CUSTOM') {
      if (!Number.isInteger(amount_cents) || amount_cents! < MIN_SPEND_CENTS) {
        throw Object.assign(
          new Error(`POLL_CUSTOM amount_cents (min ${MIN_SPEND_CENTS}) required`),
          {
            status: 400,
          },
        );
      }
      if (!poll_id) {
        throw Object.assign(new Error('POLL_CUSTOM requires poll_id'), { status: 400 });
      }
      const label =
        typeof item.data === 'object' && item.data
          ? (item.data as { label?: unknown }).label
          : null;
      const trimmed = typeof label === 'string' ? label.trim() : '';
      if (!trimmed) {
        throw Object.assign(new Error('POLL_CUSTOM requires a label'), { status: 400 });
      }
      const poll = await prisma.poll.findUnique({ where: { id: poll_id } });
      if (!poll || !poll.is_active) {
        throw Object.assign(new Error(`Poll not found or inactive: ${poll_id}`), { status: 404 });
      }
      if (!poll.allow_custom_entries) {
        throw Object.assign(new Error(`Poll does not allow custom entries: ${poll.title}`), {
          status: 400,
        });
      }
      if (poll.ends_at && new Date() > poll.ends_at) {
        throw Object.assign(new Error(`Poll has ended: ${poll.title}`), { status: 400 });
      }
      if (poll.max_entry_chars && trimmed.length > poll.max_entry_chars) {
        throw Object.assign(
          new Error(`Entry exceeds maximum of ${poll.max_entry_chars} characters`),
          { status: 400 },
        );
      }
      const blockedError = await checkBlockedWords(trimmed);
      if (blockedError) {
        throw Object.assign(new Error(blockedError), { status: 400 });
      }
      totalCents += amount_cents!;
    }
  }

  const pledgeToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + PLEDGE_TTL_MS);

  const pledge = await prisma.pendingPledge.create({
    data: {
      pledge_token: pledgeToken,
      donor_email: email || null,
      total_cents: totalCents,
      status: 'OPEN',
      expires_at: expiresAt,
      items: {
        create: items.map((item) => ({
          kind: item.kind,
          target_id: item.target_id,
          poll_id: item.poll_id || null,
          amount_cents: item.amount_cents || 0,
          data: item.data ? JSON.stringify(item.data) : null,
        })),
      },
    },
    include: { items: true },
  });

  return {
    pledge_token: pledge.pledge_token,
    total_cents: pledge.total_cents,
    expires_at: pledge.expires_at,
  };
}

/**
 * Fulfill a pledge inside an existing donation transaction.
 * Called from processDonation after the donor is upserted and balance credited.
 * Skips items that are no longer valid (sold out, ended, etc.) — those cents
 * remain as spendable balance_remaining.
 */
export async function fulfillPledge(
  tx: Prisma.TransactionClient,
  pledge: Prisma.PendingPledgeGetPayload<{ include: { items: true } }>,
  donorId: string,
) {
  const results: Array<Record<string, unknown>> = [];
  let totalSpent = 0;
  let skipped = 0;

  for (const item of pledge.items) {
    try {
      let result: { cost: number } | undefined;
      if (item.kind === 'REWARD') {
        const data = item.data ? JSON.parse(item.data) : {};
        result = await claimRewardTx(tx, donorId, item.target_id, data);
      } else if (item.kind === 'POLL_VOTE') {
        result = await votePollTx(tx, donorId, item.poll_id!, item.target_id, item.amount_cents);
      } else if (item.kind === 'GOAL') {
        result = await contributeGoalTx(tx, donorId, item.target_id, item.amount_cents);
      } else if (item.kind === 'POLL_CUSTOM') {
        const data = item.data ? JSON.parse(item.data) : {};
        result = await proposeCustomEntryTx(
          tx,
          donorId,
          item.poll_id!,
          data.label,
          item.amount_cents,
        );
      }
      totalSpent += result!.cost;
      results.push({ item_id: item.id, kind: item.kind, status: 'fulfilled', cost: result!.cost });
    } catch (err) {
      skipped++;
      results.push({
        item_id: item.id,
        kind: item.kind,
        status: 'skipped',
        reason: (err as Error).message,
      });
    }
  }

  await tx.pendingPledge.update({
    where: { id: pledge.id },
    data: { status: 'FULFILLED' },
  });

  return { totalSpent, skipped, results };
}

/**
 * Resolve a pledge token to a pending pledge, or fall back to email-based lookup.
 * Returns the pledge or null.
 */
export async function resolvePledge({
  pledgeToken,
  email,
  amountCents,
}: {
  pledgeToken?: string | null;
  email?: string | null;
  amountCents: number;
}) {
  if (pledgeToken) {
    const pledge = await prisma.pendingPledge.findUnique({
      where: { pledge_token: pledgeToken },
      include: { items: true },
    });
    if (
      pledge &&
      pledge.status === 'OPEN' &&
      pledge.total_cents <= amountCents &&
      new Date() < pledge.expires_at
    ) {
      return pledge;
    }
  }

  // Fallback: email-based lookup for newest OPEN pledge within window
  if (email) {
    const cutoff = new Date(Date.now() - PLEDGE_TTL_MS);
    const pledge = await prisma.pendingPledge.findFirst({
      where: {
        donor_email: email.trim().toLowerCase(),
        status: 'OPEN',
        total_cents: { lte: amountCents },
        expires_at: { gt: new Date() },
        created_at: { gte: cutoff },
      },
      orderBy: { created_at: 'desc' },
      include: { items: true },
    });
    if (pledge) return pledge;
  }

  return null;
}

/**
 * Create a Tiltify relay key for a pledge and return the donate URL.
 * Requires TILTIFY_CLIENT_ID, TILTIFY_CLIENT_SECRET, TILTIFY_WEBHOOK_RELAY_ID, TILTIFY_DONATE_ID.
 * Falls back to plain donate URL if relay config is missing.
 */
export async function createRelayForPledge(pledgeToken: string) {
  const relayId = process.env.TILTIFY_WEBHOOK_RELAY_ID;
  const donateId = process.env.TILTIFY_DONATE_ID;
  const donateUrl = process.env.TILTIFY_DONATE_URL;

  if (!relayId || !donateId) {
    return { donate_url: donateUrl || null, relay_client_key: null };
  }

  const { getAccessToken } = await import('./tiltify.js');
  const token = await getAccessToken('webhooks:write');

  const res = await fetch(
    `https://v5api.tiltify.com/api/private/webhook_relays/${relayId}/webhook_relay_keys`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: `pledge_${pledgeToken}`,
        metadata: '',
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('Tiltify relay key creation failed:', res.status, text);
    return { donate_url: donateUrl || null, relay_client_key: null };
  }

  const data = (await res.json()) as { data?: { client_key?: string } };
  const clientKey = data.data?.client_key;

  // Store the relay key info on the pledge
  await prisma.pendingPledge.update({
    where: { pledge_token: pledgeToken },
    data: {
      relay_key_id: `pledge_${pledgeToken}`,
      relay_client_key: clientKey,
    },
  });

  const relayUrl = `https://donate.tiltify.com/${donateId}?relay=${clientKey}`;

  const pledge = await prisma.pendingPledge.findUnique({
    where: { pledge_token: pledgeToken },
    select: { total_cents: true },
  });
  const amountParam = pledge ? `&amount=${pledge.total_cents / 100}` : '';

  return { donate_url: relayUrl + amountParam, relay_client_key: clientKey };
}
