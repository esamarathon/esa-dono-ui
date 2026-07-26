import prisma from '../lib/prisma.js';

/**
 * Check text against the global blocked-words dictionary.
 * Returns an error message string if a blocked word is found, or null if clean.
 *
 * Lives in its own module (rather than donation.ts) so it can be imported by
 * pledge.ts without creating a donation.ts <-> pledge.ts import cycle
 * (donation.ts imports resolvePledge/fulfillPledge from pledge.ts).
 */
export async function checkBlockedWords(text: string | null | undefined): Promise<string | null> {
  if (!text) return null;
  const blockedWords = await prisma.blockedWord.findMany();
  if (blockedWords.length === 0) return null;

  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const lowerBlocked = new Set(blockedWords.map((w) => w.word.toLowerCase()));

  for (const word of words) {
    if (lowerBlocked.has(word)) {
      return `Entry contains blocked word: "${word}"`;
    }
  }
  return null;
}
