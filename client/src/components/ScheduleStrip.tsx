import { useEffect, useState } from 'react';
import { useLocation, useMatch } from 'react-router-dom';
import { getSchedule } from '../api/schedule';
import { SCHEDULE_POLL_MS } from '../config';
import type { Schedule, ScheduleSlot } from '../types';

/**
 * "Live / Up next" schedule strip (#148), mounted where GlobalProgressBar used
 * to sit (above the navbar on non-home pages). It shows the Horaro schedule of
 * the Channel in context, else the single active Event's primary Channel, and
 * renders NOTHING when the state is unclear (D6/D7): no Channel, no slug,
 * nothing scheduled, or the schedule read fails.
 *
 * Mechanics (derived item 4): fixed height with no layout shift while visible,
 * plain text only (no focusable controls, no focus theft during checkout),
 * `aria-live` off for schedule changes, truncated single-line text on narrow
 * screens, no animation. The constant height and in-place content slot are kept
 * so donation acknowledgements (#250) can replace the schedule text later.
 */
export default function ScheduleStrip() {
  const location = useLocation();
  // The Channel in context: the /donate stream picker's channel segment.
  const channelMatch = useMatch('/donate/:eventSlug/:channelSlug');
  const channelSlug = channelMatch?.params.channelSlug;
  const [schedule, setSchedule] = useState<Schedule | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getSchedule(channelSlug);
        if (!cancelled) setSchedule(result);
      } catch {
        if (!cancelled) setSchedule(null);
      }
    };
    load();
    const timer = setInterval(load, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [channelSlug]);

  // The homepage has its own hero; the strip only appears above the navbar on
  // the other donation pages.
  if (location.pathname === '/') return null;

  const live = schedule?.live ?? null;
  const next = schedule?.next ?? null;
  if (!live && !next) return null;

  return (
    <div
      className="border-b px-6"
      style={{
        background: 'rgba(25, 25, 25, 0.95)',
        borderColor: 'rgba(239, 238, 236, 0.08)',
      }}
      data-testid="schedule-strip"
    >
      {/* Fixed height: content swaps (schedule <-> acknowledgement) never shift layout. */}
      <div className="max-w-6xl mx-auto h-10 flex items-center gap-8 overflow-hidden whitespace-nowrap font-data text-sm">
        {live && <StripSlot label="Live" slot={live} />}
        {next && <StripSlot label="Up next" slot={next} />}
      </div>
    </div>
  );
}

function StripSlot({ label, slot }: { label: string; slot: ScheduleSlot }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-bold text-d-yellow shrink-0">{label}</span>
      <span className="min-w-0 truncate text-off-white">{slot.game}</span>
      {slot.players && <span className="min-w-0 truncate text-off-white/55">{slot.players}</span>}
    </span>
  );
}
