import { describe, it, expect } from 'vitest';
import { sanitizeMoneyInput } from '../../src/utils/money';

describe('sanitizeMoneyInput', () => {
  it('passes through a valid 2-decimal value', () => {
    expect(sanitizeMoneyInput('12.50')).toBe('12.50');
  });

  it('truncates to 2 decimal places', () => {
    expect(sanitizeMoneyInput('12.5678')).toBe('12.56');
    expect(sanitizeMoneyInput('1.999')).toBe('1.99');
  });

  it('strips non-numeric characters', () => {
    expect(sanitizeMoneyInput('$1a2b.3c4d')).toBe('12.34');
  });

  it('collapses multiple decimal points to the first one', () => {
    expect(sanitizeMoneyInput('1.2.3.4')).toBe('1.23');
  });

  it('preserves an empty string (so the field can be cleared)', () => {
    expect(sanitizeMoneyInput('')).toBe('');
  });

  it('preserves a trailing decimal point while typing', () => {
    expect(sanitizeMoneyInput('12.')).toBe('12.');
  });

  it('strips a leading minus sign by default', () => {
    expect(sanitizeMoneyInput('-5.00')).toBe('5.00');
  });

  it('keeps a leading minus sign when allowNegative is true', () => {
    expect(sanitizeMoneyInput('-5.00', true)).toBe('-5.00');
    expect(sanitizeMoneyInput('-5.999', true)).toBe('-5.99');
  });
});
