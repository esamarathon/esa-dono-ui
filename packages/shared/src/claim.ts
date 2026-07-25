/** Reward claim data is arbitrary user-supplied JSON, persisted as a string. */
export type ClaimData = Record<string, unknown>;

export function parseClaimData(raw: string | null | undefined): ClaimData | null {
  return raw ? (JSON.parse(raw) as ClaimData) : null;
}

export function stringifyClaimData(data: ClaimData): string {
  return JSON.stringify(data);
}
