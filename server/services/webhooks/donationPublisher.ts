import type { Donation } from '@prisma/client';
import { countsTowardTotals } from '../../lib/donationTotals.js';
import {
  buildDonationCreatedPayload,
  buildDonationStateData,
  buildDonationUpdatedPayload,
  type WebhookPayloadDonationCreated,
  buildDonationModeratedPayload,
  buildDonationVisibilityPayload,
  type WebhookTx,
} from './delivery.js';
import type { EmitWebhook } from './outbox.js';
import { readDonationAccountingTx } from '../poolAccounting.js';
import { buildTiltifyDonation, buildTiltifyTotals, type TiltifyMessage } from './tiltifyPayload.js';

type DonationIds = string | readonly string[];
type DonationState = {
  donation: Donation;
  native: WebhookPayloadDonationCreated['data'];
  tiltify: TiltifyMessage | null;
};
export type DonationSnapshot = ReadonlyMap<string, DonationState | null>;

/** Donation messages and totals bound to the surrounding outbox transaction. */
export interface DonationPublisher {
  snapshot(donationIds: DonationIds): Promise<DonationSnapshot>;
  /** Null is only for new donations; existing donations require a before snapshot. */
  publish(donationIds: DonationIds, before: DonationSnapshot | null): Promise<void>;
  /** Only for PRD-0003 §T5 transition corrections, never an ordinary change. */
  forceForTransition(donationIds: DonationIds): Promise<void>;
}

export function createDonationPublisher(
  tx: WebhookTx,
  emit: EmitWebhook,
  hasTiltifyTargets: () => Promise<boolean>,
  queueTiltify: (messages: TiltifyMessage[]) => Promise<void>,
): DonationPublisher {
  const read = async (id: string): Promise<DonationState | null> => {
    const donation = await tx.donation.findUnique({ where: { id } });
    if (!donation) return null;
    return {
      donation,
      native: buildDonationStateData(
        donation,
        (await readDonationAccountingTx(tx, id)).allocations,
      ),
      tiltify:
        donation.channel_id && (await hasTiltifyTargets())
          ? await buildTiltifyDonation(tx, id)
          : null,
    };
  };
  const counted = (state: DonationState | null) =>
    state?.donation.channel_id && countsTowardTotals(state.donation.status)
      ? state.donation.amount_cents
      : 0;

  const queueTotals = async (affectedChannels: Set<string>) => {
    if (!affectedChannels.size || !(await hasTiltifyTargets())) return;
    const totals = new Map<string, TiltifyMessage>();
    for (const channelId of affectedChannels) {
      for (const message of await buildTiltifyTotals(tx, channelId))
        totals.set(message.routingKey, message);
    }
    await queueTiltify([...totals.values()]);
  };

  return {
    async snapshot(donationIds) {
      const snapshot = new Map<string, DonationState | null>();
      for (const id of new Set(typeof donationIds === 'string' ? [donationIds] : donationIds)) {
        snapshot.set(id, await read(id));
      }
      return snapshot;
    },
    async publish(donationIds, before) {
      const affectedChannels = new Set<string>();
      for (const donationId of new Set(
        typeof donationIds === 'string' ? [donationIds] : donationIds,
      )) {
        if (before && !before.has(donationId))
          throw new Error('Donation missing from before snapshot');
        const previous = before?.get(donationId) ?? null;
        const current = await read(donationId);
        if (!current) continue;
        const donation = current.donation;
        if (!donation.channel_id) continue;
        const introduced = !previous?.donation.channel_id;
        if (introduced)
          await emit('donation.created', () =>
            buildDonationCreatedPayload(donation, current.native.allocations),
          );
        else if (JSON.stringify(previous?.native) !== JSON.stringify(current.native))
          await emit('donation.updated', () => buildDonationUpdatedPayload(current.native));
        if (previous && previous.donation.moderated !== donation.moderated) {
          await emit('donation.moderated', () =>
            buildDonationModeratedPayload({
              donationId: donation.id,
              externalId: donation.external_id,
              donorRef: donation.donor_id,
              moderated: donation.moderated,
              moderatedAt: donation.moderated_at,
            }),
          );
        }
        if (previous && previous.donation.hidden_from_overlay !== donation.hidden_from_overlay) {
          await emit(donation.hidden_from_overlay ? 'donation.hidden' : 'donation.unhidden', () =>
            buildDonationVisibilityPayload(donation),
          );
        }
        if (
          current.tiltify &&
          JSON.stringify(previous?.tiltify) !== JSON.stringify(current.tiltify)
        ) {
          await queueTiltify([current.tiltify]);
        }
        if (introduced || counted(previous) !== counted(current))
          affectedChannels.add(donation.channel_id);
      }
      // All donation messages precede totals; Channels in one Event share one fact.
      await queueTotals(affectedChannels);
    },
    async forceForTransition(donationIds) {
      const affectedChannels = new Set<string>();
      for (const id of new Set(typeof donationIds === 'string' ? [donationIds] : donationIds)) {
        const current = await read(id);
        if (!current?.donation.channel_id) continue;
        await emit('donation.updated', () => buildDonationUpdatedPayload(current.native));
        if (current.tiltify) await queueTiltify([current.tiltify]);
        affectedChannels.add(current.donation.channel_id);
      }
      await queueTotals(affectedChannels);
    },
  };
}
