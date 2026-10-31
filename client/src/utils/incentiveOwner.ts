import { useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import { isAvailableOn } from '@dono/shared';
import type { Channel, Event } from '../types';

/**
 * Owner of an incentive (ADR-0012): a Channel, or a shared incentive of one Event.
 * A shared incentive is available on every Channel of its Event, and on no other.
 */
export interface IncentiveOwner {
  channel_id: string | null;
  event_id: string | null;
}

/** Staff Events for the owner picker and labels. */
export function useStaffEvents(client: AxiosInstance) {
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    client.get('/events').then((r) => setEvents(r.data));
  }, [client]);
  return events;
}

/** A new incentive is shared in the only active Event, when exactly one is active. */
export function defaultOwner(events: Event[]): IncentiveOwner {
  const active = events.filter((e) => e.is_active);
  return { channel_id: null, event_id: active.length === 1 ? active[0]!.id : null };
}

export function ownerLabel(
  row: { channel_id?: string | null; event_id?: string },
  channels: Channel[],
  events: Event[],
) {
  if (row.channel_id)
    return channels.find((c) => c.id === row.channel_id)?.name ?? 'unknown channel';
  const event = events.find((e) => e.id === row.event_id);
  return `shared · ${event?.name ?? 'unknown event'}`;
}

/** The owner fields a create or update request sends. */
export function ownerPayload(owner: IncentiveOwner) {
  return owner.channel_id
    ? { channel_id: owner.channel_id }
    : { channel_id: null, event_id: owner.event_id ?? undefined };
}

/** Staff filter: everything, or what is available on the selected Channel. */
export function availableOnSelected(
  row: { channel_id?: string | null; event_id?: string },
  channels: Channel[],
  selectedChannelId: string | null,
) {
  if (!selectedChannelId) return true;
  const channel = channels.find((c) => c.id === selectedChannelId);
  return (
    !!channel &&
    !!row.event_id &&
    isAvailableOn({ channel_id: row.channel_id ?? null, event_id: row.event_id }, channel)
  );
}
