/**
 * Money brand. All monetary values in the system are integer cents.
 * Use {@link toCents} to construct and {@link centsValue} to unwrap.
 */
export type Cents = number & { readonly __brand: 'Cents' };

/** Construct a Cents value from an integer number of cents. */
export function toCents(n: number): Cents {
  return Math.round(n) as Cents;
}

/** Unwrap a Cents value to a plain number. */
export function centsValue(c: Cents): number {
  return c as number;
}

/** Convert a decimal currency amount (e.g. "10.00" or 10) to Cents. */
export function amountToCents(amount: string | number): Cents {
  return toCents(parseFloat(String(amount)) * 100);
}
