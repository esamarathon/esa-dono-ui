import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { checkBlockedWords } from '../../services/blockedWords.js';

const prisma = new PrismaClient();

describe('checkBlockedWords', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns null for empty or null text', async () => {
    expect(await checkBlockedWords('')).toBeNull();
    expect(await checkBlockedWords(null)).toBeNull();
    expect(await checkBlockedWords(undefined)).toBeNull();
  });

  it('detects a blocked word case-insensitively', async () => {
    const word = await prisma.blockedWord.create({ data: { word: 'spamword' } });
    try {
      expect(await checkBlockedWords('this has SPAMWORD in it')).toBe(
        'Entry contains blocked word: "spamword"',
      );
    } finally {
      await prisma.blockedWord.delete({ where: { id: word.id } });
    }
  });

  it('returns null for clean text', async () => {
    const word = await prisma.blockedWord.create({ data: { word: 'spamword' } });
    try {
      expect(await checkBlockedWords('nothing bad here')).toBeNull();
    } finally {
      await prisma.blockedWord.delete({ where: { id: word.id } });
    }
  });
});
