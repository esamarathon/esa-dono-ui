export interface ClaimFieldDef {
  key: string;
  label: string;
  required: boolean;
}

/**
 * The fields one reward claim collects (#78). Required-ness derives from the
 * Custom Label: a CUSTOM reward whose staff set a `custom_type_label` requires
 * its claim answer; the fallback "Additional info" field and the shoutout
 * message stay optional, and DIGITAL/PHYSICAL collect no answer. PHYSICAL
 * rewards intentionally collect NO fields: no shipping address is captured or
 * stored by the platform.
 *
 * Every collected answer is capped at 200 characters with a visible counter
 * (#78/#80): the shoutout message counts as a claim answer for the cap too.
 * Labels are the bare answer names; the "(optional; 200 characters maximum)"
 * marker is added by the claim modal (#80).
 */
export function claimFieldsFor(reward: {
  type: string;
  custom_type_label?: string | null;
}): ClaimFieldDef[] {
  if (reward.type === 'SHOUTOUT')
    return [{ key: 'message', label: 'Shoutout message', required: false }];
  if (reward.type === 'DIGITAL' || reward.type === 'PHYSICAL') return [];
  const label = reward.custom_type_label?.trim();
  return [{ key: 'data', label: label || 'Additional info', required: !!label }];
}
