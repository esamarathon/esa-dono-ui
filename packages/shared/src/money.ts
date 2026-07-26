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

/**
 * Minimum spend enforced everywhere a donor commits balance to something
 * (poll vote, custom poll write-in, goal contribution). Single source of
 * truth for both server-side validation (services/spend.ts,
 * services/pledge.ts, routes/admin.ts) and client-side form validation —
 * change it once here to raise or lower the site-wide minimum.
 */
export const MIN_SPEND_CENTS = 100;

/** MIN_SPEND_CENTS expressed in dollars, for display/HTML `min` attributes. */
export const MIN_SPEND_DOLLARS = MIN_SPEND_CENTS / 100;
