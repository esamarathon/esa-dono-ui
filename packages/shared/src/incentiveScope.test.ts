import { describe, expect, it } from 'vitest';
import { incentiveOwnerId, isAvailableOn } from './incentiveScope.js';

const channel = { id: 'stream-1', event_id: 'event-a' };

describe('isAvailableOn', () => {
  it('accepts own Channel incentives and shared incentives of the same Event', () => {
    expect(isAvailableOn({ channel_id: 'stream-1', event_id: 'event-a' }, channel)).toBe(true);
    expect(isAvailableOn({ channel_id: null, event_id: 'event-a' }, channel)).toBe(true);
  });

  it('rejects another Channel and shared incentives of another Event', () => {
    expect(isAvailableOn({ channel_id: 'stream-2', event_id: 'event-a' }, channel)).toBe(false);
    expect(isAvailableOn({ channel_id: null, event_id: 'event-b' }, channel)).toBe(false);
  });
});

describe('incentiveOwnerId', () => {
  it('is the Channel, or the Event for a shared incentive', () => {
    expect(incentiveOwnerId({ channel_id: 'stream-1', event_id: 'event-a' })).toBe('stream-1');
    expect(incentiveOwnerId({ channel_id: null, event_id: 'event-a' })).toBe('event-a');
  });
});
