/**
 * The one shared copy set for reward keyword definitions (#78). Imported by the
 * reward card and the Help page so the two copies cannot drift. The strings are
 * FINAL and verbatim; final badge styling belongs to #80.
 */
export const REWARD_TYPE_DEFINITIONS = {
  DIGITAL: 'delivered electronically (a code, art, etc.); no shipping',
  PHYSICAL:
    'a shipped item; shipping is arranged through Stripe, and this platform never collects or stores your shipping address',
  SHOUTOUT: 'a shoutout, with an optional message you can attach',
  CUSTOM: 'anything else, described by its own label',
} as const;

export type RewardTypeKeyword = keyof typeof REWARD_TYPE_DEFINITIONS;

/** The definition string for a reward type, or undefined for an unknown type. */
export function rewardTypeDefinition(type: string): string | undefined {
  return (REWARD_TYPE_DEFINITIONS as Record<string, string | undefined>)[type];
}
