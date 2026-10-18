/**
 * ADR-0012: every incentive belongs to exactly one Event. A Channel incentive is
 * available only on its Channel; a shared incentive (no Channel) is available
 * on every Channel of its Event, and on no other Event.
 */
export interface ScopedIncentive {
  channel_id: string | null;
  event_id: string;
}

export interface ScopeChannel {
  id: string;
  event_id: string;
}

export function isAvailableOn(incentive: ScopedIncentive, channel: ScopeChannel): boolean {
  return (
    incentive.event_id === channel.event_id &&
    (incentive.channel_id === null || incentive.channel_id === channel.id)
  );
}

/** The owner a consumer files the incentive under: its Channel, else its Event (team campaign). */
export function incentiveOwnerId(incentive: ScopedIncentive): string {
  return incentive.channel_id ?? incentive.event_id;
}
