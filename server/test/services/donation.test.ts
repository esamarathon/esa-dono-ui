import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTxDonor = { upsert: vi.fn() };
const mockTxDonation = { create: vi.fn() };
const mockTx = { donor: mockTxDonor, donation: mockTxDonation };

vi.mock('../../lib/prisma.js', () => ({
  default: {
    $transaction: vi.fn(),
    donation: {
      findUnique: vi.fn(),
    },
    pendingPledge: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../services/email.js', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}));

import prisma from '../../lib/prisma.js';
import { sendMagicLink } from '../../services/email.js';

describe('processDonation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.MODERATOR_EMAILS = '';
    // Make pledge resolution return null (no pledge) by default
    const prisma = (await import('../../lib/prisma.js')).default;
    vi.mocked(prisma.pendingPledge.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.pendingPledge.findFirst).mockResolvedValue(null);
  });

  it('creates donor and donation for first-time donor', async () => {
    const donor = { id: 'donor-1', email: 'alice@example.com', magic_token: 'abc123' };
    mockTxDonor.upsert.mockResolvedValue(donor);
    mockTxDonation.create.mockResolvedValue({});
    vi.mocked(prisma.$transaction).mockImplementation((cb: any) => cb(mockTx));

    const { processDonation } = await import('../../services/donation.js');
    const result = await processDonation({
      externalId: 'tiltify-1',
      email: 'Alice@Example.com',
      donorName: 'Alice',
      amountCents: 2500,
      comment: 'Nice!',
    });

    expect((result as any).duplicate).toBeUndefined();
    expect((result as any).donor).toBe(donor);
    expect((result as any).token).toBe('abc123');
    expect(mockTxDonor.upsert).toHaveBeenCalledOnce();
    expect(mockTxDonor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'alice@example.com' },
        create: expect.objectContaining({
          email: 'alice@example.com',
          total_donated: 2500,
          balance_remaining: 2500,
          magic_token: expect.any(String),
        }),
      }),
    );
    expect(mockTxDonation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          external_id: 'tiltify-1',
          donor_id: 'donor-1',
          amount_cents: 2500,
        }),
      }),
    );
    expect(sendMagicLink).toHaveBeenCalledWith('alice@example.com', 'abc123');
  });

  it('returns { duplicate: true } when external_id already exists', async () => {
    const donor = { id: 'donor-1', email: 'alice@example.com', magic_token: 'abc123' };
    mockTxDonor.upsert.mockResolvedValue(donor);
    const p2002 = new Error('Unique constraint failed') as Error & { code: string };
    p2002.code = 'P2002';
    mockTxDonation.create.mockRejectedValue(p2002);

    const $transaction = vi.fn().mockImplementation((cb: any) =>
      cb(mockTx).catch((e: unknown) => {
        throw e;
      }),
    );
    vi.mocked(prisma.$transaction).mockImplementation($transaction);

    const { processDonation } = await import('../../services/donation.js');
    const result = await processDonation({
      externalId: 'tiltify-1',
      email: 'alice@example.com',
      donorName: 'Alice',
      amountCents: 2500,
      comment: 'Nice!',
    });

    expect(result).toEqual({ duplicate: true });
    expect(sendMagicLink).not.toHaveBeenCalled();
  });

  it('does not rotate token for repeat donations from same donor', async () => {
    const donor = { id: 'donor-1', email: 'alice@example.com', magic_token: 'stable-token' };
    mockTxDonor.upsert.mockResolvedValue(donor);
    mockTxDonation.create.mockResolvedValue({});
    vi.mocked(prisma.$transaction).mockImplementation((cb: any) => cb(mockTx));

    const { processDonation } = await import('../../services/donation.js');
    const result = await processDonation({
      externalId: 'tiltify-2',
      email: 'alice@example.com',
      donorName: 'Alice',
      amountCents: 1000,
      comment: 'Another one!',
    });

    expect((result as any).token).toBe('stable-token');
    expect(mockTxDonor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'alice@example.com' },
        update: expect.not.objectContaining({ magic_token: expect.anything() }),
      }),
    );
    expect(sendMagicLink).toHaveBeenCalledWith('alice@example.com', 'stable-token');
  });

  it('normalizes email (trim + lowercase)', async () => {
    const donor = { id: 'donor-1', email: 'bob@example.com', magic_token: 'abc' };
    mockTxDonor.upsert.mockResolvedValue(donor);
    mockTxDonation.create.mockResolvedValue({});
    vi.mocked(prisma.$transaction).mockImplementation((cb: any) => cb(mockTx));

    const { processDonation } = await import('../../services/donation.js');
    await processDonation({
      externalId: 'tid-1',
      email: '  BOB@Example.COM  ',
      donorName: 'Bob',
      amountCents: 500,
    });

    expect(mockTxDonor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'bob@example.com' },
        create: expect.objectContaining({ email: 'bob@example.com' }),
      }),
    );
    expect(sendMagicLink).toHaveBeenCalledWith('bob@example.com', expect.any(String));
  });

  it('never grants or modifies role — donating cannot buy moderator/admin access', async () => {
    const donor = {
      id: 'donor-1',
      email: 'existing@example.com',
      magic_token: 'tok',
      role: 'USER',
    };
    mockTxDonor.upsert.mockResolvedValue(donor);
    mockTxDonation.create.mockResolvedValue({});
    vi.mocked(prisma.$transaction).mockImplementation((cb: any) => cb(mockTx));

    process.env.MODERATOR_EMAILS = 'existing@example.com';
    process.env.ADMIN_EMAILS = 'existing@example.com';

    const { processDonation } = await import('../../services/donation.js');
    await processDonation({
      externalId: 'tid-2',
      email: 'existing@example.com',
      donorName: 'Existing',
      amountCents: 500,
    });

    expect(mockTxDonor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ role: expect.anything() }),
        create: expect.not.objectContaining({ role: expect.anything() }),
      }),
    );
  });
});
