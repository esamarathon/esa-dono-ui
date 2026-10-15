import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import tiltifyRouter from '../../routes/tiltify.js';

// Public HTTP wire seam, backed by the per-run migrated SQLite database.
const prisma = new PrismaClient();
const app = express();
app.use('/api/tiltify', tiltifyRouter);
const get = (path: string) => request(app).get(`/api/tiltify${path}`);
const inserted_at = '2025-01-01T00:00:00.000Z';
const updated_at = '2025-01-02T00:00:00.000Z';
const timestamps = { created_at: new Date(inserted_at), updated_at: new Date(updated_at) };
const privateMarker = 'lookup-private-marker';

describe('optional ESA incentive lookup API (#189)', () => {
  let eventId = '';
  let otherEventId = '';
  let channelA = '';
  let channelB = '';
  let otherChannel = '';
  let donorId = '';
  const rewards: string[] = [];
  const targets: string[] = [];
  const polls: Array<{ id: string; firstOption: string; secondOption: string }> = [];

  beforeAll(async () => {
    eventId = (
      await prisma.event.create({
        data: {
          name: 'Historical lookup Event',
          slug: `lookup-${randomUUID()}`,
          is_active: false,
          ended_at: new Date(updated_at),
          ended_by: privateMarker,
        },
      })
    ).id;
    otherEventId = (
      await prisma.event.create({
        data: { name: 'Other lookup Event', slug: `lookup-${randomUUID()}` },
      })
    ).id;
    for (const event_id of [eventId, eventId, otherEventId]) {
      const channel = await prisma.channel.create({
        data: {
          name: `Lookup ${randomUUID()}`,
          slug: `lookup-${randomUUID()}`,
          event_id,
          is_active: false,
        },
      });
      if (!channelA) channelA = channel.id;
      else if (!channelB) channelB = channel.id;
      else otherChannel = channel.id;
    }
    // Order: own, shared, same-Event foreign Channel, other-Event Channel.
    for (const channel_id of [channelA, null, channelB, otherChannel]) {
      rewards.push(
        (
          await prisma.reward.create({
            data: {
              title: 'Historical reward',
              description: 'Public reward description',
              type: 'CUSTOM',
              cost_cents: 725,
              quantity_total: 10,
              quantity_claimed: 12,
              is_active: false,
              channel_id,
              ...timestamps,
            },
          })
        ).id,
      );
    }
    for (const channel_id of [channelA, null, channelB, otherChannel]) {
      targets.push(
        (
          await prisma.fundGoal.create({
            data: {
              title: 'Historical target',
              target_cents: 123_450,
              current_cents: 6_789,
              is_active: false,
              channel_id,
              ...timestamps,
            },
          })
        ).id,
      );
    }
    for (const channel_id of [channelA, null, channelB, otherChannel]) {
      const poll = await prisma.poll.create({
        data: {
          title: 'Ended poll',
          is_active: true,
          ends_at: new Date(updated_at),
          total_votes_cents: 2_500,
          channel_id,
          ...timestamps,
          options: {
            create: [
              { label: 'Second approved', votes_cents: 500 },
              { label: privateMarker, votes_cents: 700, status: 'PENDING_APPROVAL' },
              { label: privateMarker, votes_cents: 300, status: 'REJECTED' },
              { label: 'First approved', votes_cents: 1_000 },
            ],
          },
        },
        include: { options: true },
      });
      polls.push({
        id: poll.id,
        firstOption: poll.options.find((o) => o.label === 'First approved')!.id,
        secondOption: poll.options.find((o) => o.label === 'Second approved')!.id,
      });
    }
    donorId = (
      await prisma.donor.create({
        data: {
          email: `${privateMarker}-${randomUUID()}@example.com`,
          magic_token: randomUUID(),
          role: 'ADMIN',
        },
      })
    ).id;
    await prisma.rewardClaim.create({
      data: {
        reward_id: rewards[2]!,
        donor_id: donorId,
        claim_data: JSON.stringify({ answer: privateMarker }),
        reversed_by: privateMarker,
        chargeback_acknowledgement_note: privateMarker,
      },
    });
  });

  afterAll(async () => {
    await prisma.rewardClaim.deleteMany({ where: { donor_id: donorId } });
    await prisma.donor.deleteMany({ where: { id: donorId } });
    await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: targets } } });
    await prisma.poll.deleteMany({ where: { id: { in: polls.map((p) => p.id) } } });
    await prisma.channel.deleteMany({ where: { id: { in: [channelA, channelB, otherChannel] } } });
    await prisma.event.deleteMany({ where: { id: { in: [eventId, otherEventId] } } });
    await prisma.$disconnect();
  });

  it('looks up own, shared and same-Event foreign ended polls with only approved options in vote order', async () => {
    for (const context of [channelA, eventId]) {
      for (const [index, campaign_id] of [channelA, null, channelB].entries()) {
        const poll = polls[index]!;
        const res = await get(`/campaign/${context}/lookup/polls/${poll.id}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          campaign_id,
          incentive: {
            id: poll.id,
            name: 'Ended poll',
            active: false,
            amount_raised: { currency: 'USD', value: '25.00' },
            inserted_at,
            updated_at,
            options: [
              {
                id: poll.firstOption,
                name: 'First approved',
                amount_raised: { currency: 'USD', value: '10.00' },
              },
              {
                id: poll.secondOption,
                name: 'Second approved',
                amount_raised: { currency: 'USD', value: '5.00' },
              },
            ],
          },
        });
        expect(res.text).not.toContain(privateMarker);
        const list = await get(`/campaign/${campaign_id ?? channelA}/polls`);
        expect(list.body.find((p: { id: string }) => p.id === poll.id)).toEqual(res.body.incentive);
        const detail = await get(`/campaign/${campaign_id ?? channelA}/polls/${poll.id}`);
        expect(detail.body).toEqual(res.body.incentive);
      }
    }
  });

  it('looks up own, shared and same-Event foreign targets with the true owner and exact bare DTO', async () => {
    for (const context of [channelA, eventId]) {
      for (const [index, campaign_id] of [channelA, null, channelB].entries()) {
        const res = await get(`/campaign/${context}/lookup/targets/${targets[index]}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          campaign_id,
          incentive: {
            id: targets[index],
            name: 'Historical target',
            active: false,
            amount: { currency: 'USD', value: '1234.50' },
            amount_raised: { currency: 'USD', value: '67.89' },
            inserted_at,
            updated_at,
          },
        });
        expect(res.text).not.toContain(privateMarker);
        const list = await get(`/campaign/${campaign_id ?? channelA}/targets`);
        expect(list.body.find((t: { id: string }) => t.id === targets[index])).toEqual(
          res.body.incentive,
        );
      }
    }
  });

  it('rejects unknown contexts, missing or wrong-kind resources, and owners in another Event', async () => {
    for (const [kind, ids] of [
      ['rewards', rewards],
      ['targets', targets],
      ['polls', polls.map((p) => p.id)],
    ] as const) {
      for (const context of [channelA, eventId]) {
        for (const id of [randomUUID(), 'not-a-uuid', ids[3]]) {
          const res = await get(`/campaign/${context}/lookup/${kind}/${id}`);
          expect(res.status).toBe(404);
          expect(Object.keys(res.body)).toEqual(['error']);
        }
      }
      for (const context of [otherChannel, otherEventId]) {
        expect((await get(`/campaign/${context}/lookup/${kind}/${ids[0]}`)).status).toBe(404);
        const shared = await get(`/campaign/${context}/lookup/${kind}/${ids[1]}`);
        expect(shared.status).toBe(200);
        expect(shared.body.campaign_id).toBeNull();
      }
      for (const context of [randomUUID(), 'not-a-uuid']) {
        expect((await get(`/campaign/${context}/lookup/${kind}/${ids[1]}`)).status).toBe(404);
      }
    }
    expect((await get(`/campaign/${channelA}/lookup/rewards/${targets[0]}`)).status).toBe(404);
    expect((await get(`/campaign/${channelA}/lookup/targets/${polls[0]!.id}`)).status).toBe(404);
    expect((await get(`/campaign/${channelA}/lookup/polls/${rewards[0]}`)).status).toBe(404);
  });

  it('does not widen Channel lists, Event lists or ordinary poll detail', async () => {
    for (const [kind, ids] of [
      ['rewards', rewards],
      ['targets', targets],
      ['polls', polls.map((p) => p.id)],
    ] as const) {
      for (const [context, expected] of [
        [channelA, [ids[0], ids[1]]],
        [channelB, [ids[1], ids[2]]],
        [eventId, []],
      ] as const) {
        const res = await get(`/campaign/${context}/${kind}`);
        expect(res.status).toBe(200);
        // Other route suites also create globally shared incentives.
        const ours = res.body.filter((r: { id: string }) => ids.includes(r.id));
        expect(ours.map((r: { id: string }) => r.id).sort()).toEqual([...expected].sort());
        if (context === eventId) expect(res.body).toEqual([]);
        for (const resource of res.body) expect(resource).not.toHaveProperty('campaign_id');
      }
    }
    expect((await get(`/campaign/${channelA}/polls/${polls[2]!.id}`)).status).toBe(404);
    expect((await get(`/campaign/${eventId}/polls/${polls[1]!.id}`)).status).toBe(404);
  });

  it('looks up own, shared and same-Event foreign rewards with the true owner and exact bare DTO', async () => {
    for (const context of [channelA, eventId]) {
      for (const [index, campaign_id] of [channelA, null, channelB].entries()) {
        const res = await get(`/campaign/${context}/lookup/rewards/${rewards[index]}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          campaign_id,
          incentive: {
            id: rewards[index],
            name: 'Historical reward',
            description: 'Public reward description',
            active: false,
            amount: { currency: 'USD', value: '7.25' },
            quantity: 10,
            quantity_remaining: 0,
            inserted_at,
            updated_at,
          },
        });
        expect(res.text).not.toContain(privateMarker);
        const list = await get(`/campaign/${campaign_id ?? channelA}/rewards`);
        expect(list.body.find((r: { id: string }) => r.id === rewards[index])).toEqual(
          res.body.incentive,
        );
      }
    }
  });

  it('re-reads current prices, stock, target progress and newly approved poll options without a warm list', async () => {
    const refreshedAt = '2025-01-03T00:00:00.000Z';
    const foreignPoll = polls[2]!;
    const newOption = await prisma.pollOption.create({
      data: { poll_id: foreignPoll.id, label: 'New approved', votes_cents: 1_200 },
    });
    try {
      await prisma.reward.update({
        where: { id: rewards[2] },
        data: {
          cost_cents: 1_025,
          quantity_claimed: 2,
          is_active: true,
          updated_at: new Date(refreshedAt),
        },
      });
      await prisma.fundGoal.update({
        where: { id: targets[2] },
        data: { current_cents: 12_000, is_active: true, updated_at: new Date(refreshedAt) },
      });
      await prisma.poll.update({
        where: { id: foreignPoll.id },
        data: {
          total_votes_cents: 3_700,
          is_active: false,
          ends_at: null,
          updated_at: new Date(refreshedAt),
        },
      });
      const reward = await get(`/campaign/${channelA}/lookup/rewards/${rewards[2]}`);
      expect(reward.status).toBe(200);
      expect(reward.body).toEqual({
        campaign_id: channelB,
        incentive: {
          id: rewards[2],
          name: 'Historical reward',
          description: 'Public reward description',
          active: true,
          amount: { currency: 'USD', value: '10.25' },
          quantity: 10,
          quantity_remaining: 8,
          inserted_at,
          updated_at: refreshedAt,
        },
      });
      const target = await get(`/campaign/${channelA}/lookup/targets/${targets[2]}`);
      expect(target.status).toBe(200);
      expect(target.body).toEqual({
        campaign_id: channelB,
        incentive: {
          id: targets[2],
          name: 'Historical target',
          active: true,
          amount: { currency: 'USD', value: '1234.50' },
          amount_raised: { currency: 'USD', value: '120.00' },
          inserted_at,
          updated_at: refreshedAt,
        },
      });
      const poll = await get(`/campaign/${channelA}/lookup/polls/${foreignPoll.id}`);
      expect(poll.status).toBe(200);
      expect(poll.body).toEqual({
        campaign_id: channelB,
        incentive: {
          id: foreignPoll.id,
          name: 'Ended poll',
          active: false,
          amount_raised: { currency: 'USD', value: '37.00' },
          inserted_at,
          updated_at: refreshedAt,
          options: [
            {
              id: newOption.id,
              name: 'New approved',
              amount_raised: { currency: 'USD', value: '12.00' },
            },
            {
              id: foreignPoll.firstOption,
              name: 'First approved',
              amount_raised: { currency: 'USD', value: '10.00' },
            },
            {
              id: foreignPoll.secondOption,
              name: 'Second approved',
              amount_raised: { currency: 'USD', value: '5.00' },
            },
          ],
        },
      });
      for (const res of [reward, target, poll]) expect(res.text).not.toContain(privateMarker);
    } finally {
      await prisma.pollOption.delete({ where: { id: newOption.id } });
      await prisma.reward.update({
        where: { id: rewards[2] },
        data: { cost_cents: 725, quantity_claimed: 12, is_active: false, ...timestamps },
      });
      await prisma.fundGoal.update({
        where: { id: targets[2] },
        data: { current_cents: 6_789, is_active: false, ...timestamps },
      });
      await prisma.poll.update({
        where: { id: foreignPoll.id },
        data: {
          total_votes_cents: 2_500,
          is_active: true,
          ends_at: new Date(updated_at),
          ...timestamps,
        },
      });
    }
  });
});
