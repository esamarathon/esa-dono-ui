export interface ClaimFieldDef {
  key: string;
  label: string;
  required: boolean;
  /** Claim answers cap at 200 characters with a live counter (#78). */
  capped?: boolean;
}

/**
 * The fields one reward claim collects (#78). Required-ness derives from the
 * Custom Label: a CUSTOM reward whose staff set a `custom_type_label` requires
 * its claim answer; the fallback "Additional Info" field and the shoutout
 * message stay optional, and DIGITAL/PHYSICAL collect no answer. PHYSICAL
 * rewards intentionally collect NO fields: no shipping address is captured or
 * stored by the platform.
 */
export function claimFieldsFor(reward: {
  type: string;
  custom_type_label?: string | null;
}): ClaimFieldDef[] {
  if (reward.type === 'SHOUTOUT')
    return [{ key: 'message', label: 'Shoutout Message', required: false }];
  if (reward.type === 'DIGITAL' || reward.type === 'PHYSICAL') return [];
  const label = reward.custom_type_label?.trim();
  return [{ key: 'data', label: label || 'Additional Info', required: !!label, capped: true }];
}
