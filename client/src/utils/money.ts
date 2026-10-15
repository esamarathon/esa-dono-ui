/**
 * Sanitize free-typed currency input to at most 2 decimal places, stripping
 * any characters that aren't digits, a single decimal point, or (optionally)
 * a leading minus sign. Meant to be applied in an <input type="number">'s
 * onChange before the value is stored in state, so the field can never hold
 * more precision than whole cents.
 */
export function sanitizeMoneyInput(value: string, allowNegative = false): string {
  let negative = false;
  let v = value;

  if (allowNegative && v.startsWith('-')) {
    negative = true;
    v = v.slice(1);
  }

  // Strip anything that isn't a digit or a dot.
  v = v.replace(/[^0-9.]/g, '');

  // Collapse to a single decimal point (keep the first one).
  const firstDot = v.indexOf('.');
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  }

  // Limit to 2 digits after the decimal point.
  const [whole, decimals] = v.split('.');
  if (decimals !== undefined) {
    v = `${whole}.${decimals.slice(0, 2)}`;
  }

  return negative ? `-${v}` : v;
}

export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format the server's destinations without recalculating any allocation or credit. */
export function reversalText(preview: import('../types').ReversalPreview): string {
  return (
    preview.destinations
      .map(
        (row) =>
          `+${fmt(row.amount_cents)} ${row.category} ${row.destination}${row.donation_id ? ` of donation ${row.donation_id}` : ''}${row.credit_id ? ` (original grant ${row.credit_id})` : ''}`,
      )
      .join('\n') || 'No credit is returned.'
  );
}
