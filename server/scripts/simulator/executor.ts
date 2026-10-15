/**
 * Serial HTTP executor (wayfinder #37). Dispatches the decision log against the
 * live API one event at a time (serial = deterministic server-observed order,
 * #32.2), resolving synthetic refs to server ids (#34) and threading a `runId`
 * into donor emails so runs don't collide (`sim-<runId>+<donorRef>@demo.test`).
 *
 * Donor magic tokens are captured from the admin simulate-donation response and
 * reused as the Bearer for that donor's subsequent spends (#33).
 */
import type { Catalog, DecisionEntry, OutcomeEntry } from './types.js';
import crypto from 'node:crypto';
import { MIN_SPEND_CENTS, planPledge, type PledgeItemKind } from '@dono/shared';

type CheckoutItem = {
  kind: PledgeItemKind;
  target_id: string;
  amount_cents: number;
  poll_id?: string;
  quantity?: number;
};

export interface ExecutorOptions {
  baseUrl: string;
  adminKey: string;
  runId: string;
  catalog: Catalog;
}

/** Donor email for a synthetic donorRef, namespaced by runId (#34 isolation). */
function donorEmail(runId: string, donorRef: string): string {
  return `sim-${runId}+${donorRef}@demo.test`;
}

export class Executor {
  private tokens = new Map<string, string>(); // donorRef -> magic token

  constructor(private opts: ExecutorOptions) {}

  async execute(entry: DecisionEntry): Promise<OutcomeEntry> {
    const start = Date.now();
    try {
      const { status, accepted, note } = await this.dispatch(entry);
      return {
        seq: entry.seq,
        action: entry.action,
        status,
        accepted,
        latencyMs: Date.now() - start,
        note,
      };
    } catch (err) {
      return {
        seq: entry.seq,
        action: entry.action,
        status: 0,
        accepted: false,
        latencyMs: Date.now() - start,
        note: `executor error: ${(err as Error).message}`,
      };
    }
  }

  private ref(r: string): string {
    const id = this.opts.catalog.resolve[r];
    if (!id) throw new Error(`unresolved synthetic ref: ${r}`);
    return id;
  }

  private async dispatch(
    entry: DecisionEntry,
  ): Promise<{ status: number; accepted: boolean; note?: string }> {
    const { baseUrl } = this.opts;
    const donorRef = entry.actor.donorRef;
    const p = entry.params;

    switch (entry.action) {
      case 'DONATE': {
        const body = {
          email: donorEmail(this.opts.runId, donorRef),
          donor_name: p.displayName ?? donorRef,
          amount_cents: p.amountCents,
          comment: p.comment as string | undefined,
          channel_id: p.channelRef ? this.ref(p.channelRef as string) : null,
        };
        const res = await fetch(`${baseUrl}/api/admin/simulate-donation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer key_admin_${this.opts.adminKey}`,
          },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const json = (await res.json()) as { token?: string };
          if (json.token) this.tokens.set(donorRef, json.token);
        }
        return { status: res.status, accepted: res.ok };
      }

      case 'CLAIM_REWARD':
        return this.spend(donorRef, `/api/rewards/${this.ref(entry.targetRef!.rewardRef!)}/claim`, {
          claim_data: {},
          quantity: p.quantity ?? 1,
        });

      case 'VOTE_POLL':
        return this.spend(donorRef, `/api/polls/${this.ref(entry.targetRef!.pollRef!)}/vote`, {
          poll_option_id: this.ref(entry.targetRef!.optionRef!),
          amount_cents: p.amountCents,
        });

      case 'CONTRIBUTE_GOAL':
        return this.spend(
          donorRef,
          `/api/goals/${this.ref(entry.targetRef!.goalRef!)}/contribute`,
          {
            amount_cents: p.amountCents,
          },
        );

      case 'BID_AUCTION': {
        // Known limitation (#33/#37): the pure-API path cannot set email_verified,
        // so the server gates these with 403. Attempted for coverage; flagged.
        const out = await this.spend(
          donorRef,
          `/api/auctions/${this.ref(entry.targetRef!.auctionRef!)}/bid`,
          { amount_cents: p.amountCents },
        );
        if (out.status === 403) {
          out.note = 'expected: auction bids require email_verified (no API to set it)';
        }
        return out;
      }

      case 'PLEDGE_CHECKOUT': {
        const channelId = this.ref(entry.targetRef!.channelRef!);
        if (entry.items !== undefined) {
          const items = entry.items.map((item) => {
            switch (item.kind) {
              case 'REWARD':
                return {
                  kind: item.kind,
                  target_id: this.ref(item.rewardRef),
                  amount_cents: item.amountCents,
                  quantity: item.quantity,
                };
              case 'POLL_VOTE':
                return {
                  kind: item.kind,
                  target_id: this.ref(item.optionRef),
                  poll_id: this.ref(item.pollRef),
                  amount_cents: item.amountCents,
                };
              case 'GOAL':
                return {
                  kind: item.kind,
                  target_id: this.ref(item.goalRef),
                  amount_cents: item.amountCents,
                };
            }
          });
          return this.pledgeCheckout(donorRef, items, channelId, p, entry.seq);
        }

        // V1 replay: one cart line stored in params + targetRef.
        const itemKind = p.itemKind as 'REWARD' | 'POLL_VOTE' | 'GOAL';
        let item: CheckoutItem;
        if (itemKind === 'REWARD') {
          item = {
            kind: 'REWARD',
            target_id: this.ref(entry.targetRef!.rewardRef!),
            amount_cents: p.amountCents as number,
          };
        } else if (itemKind === 'POLL_VOTE') {
          item = {
            kind: 'POLL_VOTE',
            target_id: this.ref(entry.targetRef!.optionRef!),
            poll_id: this.ref(entry.targetRef!.pollRef!),
            amount_cents: p.amountCents as number,
          };
        } else {
          item = {
            kind: 'GOAL',
            target_id: this.ref(entry.targetRef!.goalRef!),
            amount_cents: p.amountCents as number,
          };
        }
        return this.pledgeCheckout(donorRef, [item], channelId, p, entry.seq);
      }
    }
  }

  /** POST to a donor-authenticated spend route using that donor's magic token. */
  private async spend(
    donorRef: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; accepted: boolean; note?: string }> {
    const token = this.tokens.get(donorRef);
    if (!token) {
      return {
        status: 0,
        accepted: false,
        note: `donor ${donorRef} has no token yet (no prior donation)`,
      };
    }
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, accepted: res.ok };
  }

  /**
   * Confirm the shared plan through /api/pledge, then read the actual pledge
   * state. This simulator never completes Stripe or releases Wallet funding.
   * HTTP success and a zero new-money estimate alone do not prove fulfillment.
   */
  private async pledgeCheckout(
    donorRef: string,
    items: CheckoutItem[],
    channelId: string,
    params: DecisionEntry['params'],
    seq: number,
  ): Promise<{ status: number; accepted: boolean; note?: string }> {
    const token = this.tokens.get(donorRef);
    if (!token) {
      return {
        status: 0,
        accepted: false,
        note: `donor ${donorRef} has no token yet (no prior donation)`,
      };
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    // Plan from actual review boundaries, not cached donation balances or old totals.
    const wallet = await fetch(`${this.opts.baseUrl}/api/donor`, { headers });
    if (!wallet.ok) return { status: wallet.status, accepted: false };
    const available = (await wallet.json()) as { balance_remaining: number };
    const rewards = items.some((item) => item.kind === 'REWARD')
      ? await fetch(`${this.opts.baseUrl}/api/rewards`)
      : null;
    if (rewards && !rewards.ok) return { status: rewards.status, accepted: false };
    const catalog = rewards
      ? ((await rewards.json()) as Array<{ id: string; cost_cents: number; type: string }>)
      : [];
    const selections = items.map((item, insertion_order) => {
      const reward =
        item.kind === 'REWARD' ? catalog.find((reward) => reward.id === item.target_id) : null;
      if (item.kind === 'REWARD' && !reward)
        throw new Error(`Reward unavailable at review: ${item.target_id}`);
      return {
        ...item,
        insertion_order,
        unit_price_cents: reward?.cost_cents,
        reward_type: reward?.type,
      };
    });
    const usage = planPledge({
      pledge_amount_cents: MIN_SPEND_CENTS,
      selections,
      available_wallet_cents: null,
    }).usage_cents;
    // Older replay logs have no amount-first field. Fit their selections into
    // the smallest independent Pools; do not restore the old summed-cart wire.
    const amount =
      typeof params.pledgeAmountCents === 'number'
        ? params.pledgeAmountCents
        : Math.max(MIN_SPEND_CENTS, ...Object.values(usage));
    const plan = planPledge({
      pledge_amount_cents: amount,
      selections,
      available_wallet_cents: available.balance_remaining,
    });
    const draftId = crypto
      .createHash('sha256')
      .update(JSON.stringify([this.opts.runId, donorRef, seq]))
      .digest('hex');
    const res = await fetch(`${this.opts.baseUrl}/api/pledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        items,
        pledge_amount_cents: amount,
        draft_id: draftId,
        plan,
        channel_id: channelId,
        comment: params.comment,
        display_name: params.displayName,
      }),
    });
    if (!res.ok) return { status: res.status, accepted: false };

    const json = (await res.json()) as { pledge_token?: string };
    if (!json.pledge_token)
      return { status: res.status, accepted: false, note: 'pledge response has no token' };
    const state = await fetch(`${this.opts.baseUrl}/api/pledge/${json.pledge_token}`);
    if (!state.ok) return { status: state.status, accepted: false };
    const pledge = (await state.json()) as { format?: string; status?: string };
    const fulfilled = pledge.format === 'POOLED' && pledge.status === 'FULFILLED';
    return {
      status: res.status,
      accepted: fulfilled,
      note: fulfilled
        ? undefined
        : 'pledge not fulfilled (no Stripe in sim); confirmed funding stays held until non-payment is reconciled',
    };
  }
}
