import { describe, expect, it } from 'vitest';
import { CLAIM_ANSWER_MAX_CHARS, claimAnswerError } from './claim.js';

const over = 'x'.repeat(CLAIM_ANSWER_MAX_CHARS + 1);
const exact = 'x'.repeat(CLAIM_ANSWER_MAX_CHARS);

describe('claimAnswerError', () => {
  it('caps a shoutout message at 200 characters (#80)', () => {
    expect(claimAnswerError({ message: over }, { type: 'SHOUTOUT' })).toBe(
      `answer exceeds maximum of ${CLAIM_ANSWER_MAX_CHARS} characters`,
    );
    expect(claimAnswerError({ message: exact }, { type: 'SHOUTOUT' })).toBeNull();
    expect(claimAnswerError({ message: 'hi' }, { type: 'SHOUTOUT' })).toBeNull();
    // The shoutout message stays optional.
    expect(claimAnswerError({}, { type: 'SHOUTOUT' })).toBeNull();
    expect(claimAnswerError({ message: '' }, { type: 'SHOUTOUT' })).toBeNull();
  });

  it('caps any collected answer text regardless of reward type', () => {
    expect(claimAnswerError(over, { type: 'DIGITAL' })).toBe(
      `answer exceeds maximum of ${CLAIM_ANSWER_MAX_CHARS} characters`,
    );
    expect(claimAnswerError({ data: over }, { type: 'PHYSICAL' })).toBe(
      `answer exceeds maximum of ${CLAIM_ANSWER_MAX_CHARS} characters`,
    );
  });

  it('collects nothing to validate for DIGITAL/PHYSICAL answers', () => {
    expect(claimAnswerError(null, { type: 'DIGITAL' })).toBeNull();
    expect(claimAnswerError({ data: '' }, { type: 'PHYSICAL' })).toBeNull();
  });

  it('requires a non-blank answer only for a CUSTOM reward with a Custom Label (#78)', () => {
    const labeled = { type: 'CUSTOM', custom_type_label: 'Game pick' };
    expect(claimAnswerError({}, labeled)).toBe('answer is required');
    expect(claimAnswerError({ data: '   ' }, labeled)).toBe('answer is required');
    expect(claimAnswerError({ data: 'Celeste' }, labeled)).toBeNull();
    const fallback = { type: 'CUSTOM', custom_type_label: null };
    expect(claimAnswerError({}, fallback)).toBeNull();
  });

  it('reports the length cap before required-ness', () => {
    expect(
      claimAnswerError({ data: over }, { type: 'CUSTOM', custom_type_label: 'Game pick' }),
    ).toBe(`answer exceeds maximum of ${CLAIM_ANSWER_MAX_CHARS} characters`);
  });
});
