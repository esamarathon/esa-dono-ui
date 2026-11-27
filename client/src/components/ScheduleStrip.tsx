import { useEffect, useRef, useState } from 'react';
import { useLocation, useMatch } from 'react-router-dom';
import { getSchedule } from '../api/schedule';
import { ACK_SLOT_MS, SCHEDULE_POLL_MS } from '../config';
import type { Schedule, ScheduleRecentDonation, ScheduleSlot } from '../types';

/** Ack amounts render with forced two decimals ("$25.00", "$25.50"), matching
 *  the grilling-approved copy in #250 Q4/Q5 ("Sam donated $25.00") and the
 *  strip's earlier money rendering (GlobalProgressBar). */
function fmtAckAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const amount = Math.abs(cents) / 100;
  return `${sign}$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** D4/D5 individual acknowledgement copy: "Sam donated $25.00". */
function ackLine(donation: ScheduleRecentDonation): string {
  return `${donation.display_name} donated ${fmtAckAmount(donation.amount_cents)}`;
}

/**
 * "Live / Up next" schedule strip (#148) with step 2's donation
 * acknowledgements (#250), mounted where GlobalProgressBar used to sit (above
 * the navbar on non-home pages). It shows the schedule of the Channel in
 * context (Crew Corner's published schedule, #286), else the single active
 * Event's primary Channel, and renders NOTHING when the state is unclear
 * (D6/D7): no Channel, no slug, nothing scheduled, or the schedule read fails.
 *
 * Acknowledgements (D3–D7): after an ack-eligible donation is observed, the
 * schedule text is replaced IN PLACE for one ~5 s slot — an individual
 * "Sam donated $25.00", or "N donations in the last minute" while two or more
 * donations sit in the rolling one-minute window — then the schedule returns.
 * There is no queue: nothing created before the load (or a reconnect, which
 * behaves exactly like a fresh load) is ever acknowledged (D9), and each
 * donation is acknowledged at most once per visit (D6). While the
 * `donation-acknowledgements` feature flag is off the server omits the
 * donation data and this stays a schedule-only strip (D11).
 *
 * Mechanics (derived item 4): fixed height with no layout shift while visible,
 * plain text only (no focusable controls, no focus theft during checkout),
 * `aria-live` off (D10), truncated single-line text on narrow screens, no
 * animation — the constant height and in-place content slot serve exactly the
 * schedule <-> acknowledgement swap.
 */
export default function ScheduleStrip() {
  const location = useLocation();
  // The Channel in context: the /donate stream picker's channel segment.
  const channelMatch = useMatch('/donate/:eventSlug/:channelSlug');
  const channelSlug = channelMatch?.params.channelSlug;
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [ackText, setAckText] = useState<string | null>(null);

  // D9: the window counts only donations observed during the visit — nothing
  // created before the load. A reconnect resets the baseline, so refresh and
  // reconnect behave identically.
  const loadTimeRef = useRef(Date.now());
  // D6: each donation is acknowledged at most once per visit.
  const acknowledgedRef = useRef(new Set<string>());
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let failed = false;

    /** One acknowledgement slot (D6/D7), then back to the schedule. */
    const showAck = (text: string) => {
      setAckText(text);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => setAckText(null), ACK_SLOT_MS);
    };

    const acknowledge = (result: Schedule) => {
      const observed = (result.recent_donations ?? []).filter(
        (d) => Date.parse(d.created_at) > loadTimeRef.current,
      );
      const fresh = observed.filter((d) => !acknowledgedRef.current.has(d.id));
      // D7: one-shot — the same display is never re-shown until another
      // donation arrives.
      if (fresh.length === 0) return;
      for (const d of fresh) acknowledgedRef.current.add(d.id);
      if (observed.length >= 2) {
        // D6: during a burst the aggregate replaces the individual ack.
        showAck(`${observed.length} donations in the last minute`);
        return;
      }
      const newest = fresh.reduce((a, b) =>
        Date.parse(a.created_at) > Date.parse(b.created_at) ? a : b,
      );
      showAck(ackLine(newest));
    };

    const load = async () => {
      try {
        const result = await getSchedule(channelSlug);
        if (cancelled) return;
        if (failed) {
          // D9: a reconnect behaves exactly like a fresh load — nothing
          // created before it is acknowledged, and no queue is replayed.
          failed = false;
          loadTimeRef.current = Date.now();
        }
        setSchedule(result);
        acknowledge(result);
      } catch {
        if (!cancelled) {
          failed = true;
          setSchedule(null);
        }
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
  // D3: acknowledgements ride the schedule's render decision — wherever the
  // strip renders nothing, there are none.
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
        {ackText !== null ? (
          // D4/D10: plain text in place of the schedule — name and amount
          // only, never the comment; nothing focusable, no animation.
          <span className="min-w-0 truncate text-off-white" data-testid="donation-ack">
            {ackText}
          </span>
        ) : (
          <>
            {live && <StripSlot label="Live" slot={live} />}
            {next && <StripSlot label="Up next" slot={next} />}
          </>
        )}
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
