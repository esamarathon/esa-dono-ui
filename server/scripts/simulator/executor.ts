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
          donor_name: donorRef,
          amount_cents: p.amountCents,
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
}
