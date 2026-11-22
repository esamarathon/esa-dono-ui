/** Reward claim data is arbitrary user-supplied JSON, persisted as a string. */
export type ClaimData = Record<string, unknown>;

/**
 * Claim answers cap at 200 characters (#78). A code constant, not a staff field:
 * it protects the stream overlay from unbounded answers.
 */
export const CLAIM_ANSWER_MAX_CHARS = 200;

/** The top-level donor texts inside a claim's data; a bare string counts as one. */
function claimAnswerTexts(claimData: unknown): string[] {
  if (typeof claimData === 'string') return [claimData];
  if (!claimData || typeof claimData !== 'object' || Array.isArray(claimData)) return [];
  return Object.values(claimData).filter((value): value is string => typeof value === 'string');
}

/**
 * Required-ness derives from the Custom Label (#78): a CUSTOM reward whose staff
 * set a `custom_type_label` requires a non-blank claim answer; the fallback
 * "Additional Info" field stays optional, the shoutout message stays optional,
 * and DIGITAL/PHYSICAL rewards collect no answer. The answer's key is the
 * collecting client's choice, so any non-blank text counts. Returns an error
 * message, or null when the claim may be created.
 */
export function claimAnswerError(
  claimData: unknown,
  reward: { type: string; custom_type_label?: string | null },
): string | null {
  if (reward.type !== 'CUSTOM') return null;
  const answers = claimAnswerTexts(claimData);
  if (answers.some((answer) => answer.length > CLAIM_ANSWER_MAX_CHARS))
    return `answer exceeds maximum of ${CLAIM_ANSWER_MAX_CHARS} characters`;
  if ((reward.custom_type_label ?? '').trim() && !answers.some((answer) => answer.trim()))
    return 'answer is required';
  return null;
}

export function parseClaimData(raw: string | null | undefined): ClaimData | null {
  return raw ? (JSON.parse(raw) as ClaimData) : null;
}

export function stringifyClaimData(data: ClaimData): string {
  return JSON.stringify(data);
}
