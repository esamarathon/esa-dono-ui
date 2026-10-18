import type { Channel, Event } from '../types';
import type { IncentiveOwner } from '../utils/incentiveOwner';

const value = (owner: IncentiveOwner) =>
  owner.channel_id
    ? `channel:${owner.channel_id}`
    : owner.event_id
      ? `event:${owner.event_id}`
      : '';

/**
 * Pick a Channel, or "shared" within one Event. An existing incentive keeps its
 * Event, so editing offers only that Event's choices.
 */
export function IncentiveOwnerSelect({
  channels,
  events,
  owner,
  fixedEventId,
  onChange,
}: {
  channels: Channel[];
  events: Event[];
  owner: IncentiveOwner;
  fixedEventId?: string;
  onChange: (owner: IncentiveOwner) => void;
}) {
  const shown = fixedEventId ? events.filter((e) => e.id === fixedEventId) : events;
  return (
    <div className="mb-3">
      <label
        htmlFor="incentive_owner"
        className="block font-data font-bold text-sm mb-1 text-off-white"
      >
        channel
      </label>
      <select
        id="incentive_owner"
        className="w-full px-3 py-2 text-sm"
        value={value(owner)}
        onChange={(e) => {
          const [kind, id] = e.target.value.split(':') as ['channel' | 'event', string];
          onChange(
            kind === 'channel'
              ? { channel_id: id, event_id: channels.find((c) => c.id === id)?.event_id ?? null }
              : { channel_id: null, event_id: id },
          );
        }}
      >
        {!value(owner) && (
          <option value="" disabled>
            choose a channel or event
          </option>
        )}
        {shown.map((event) => (
          <optgroup key={event.id} label={event.name}>
            <option value={`event:${event.id}`}>shared (every channel of {event.name})</option>
            {channels
              .filter((c) => c.event_id === event.id)
              .map((c) => (
                <option key={c.id} value={`channel:${c.id}`}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
