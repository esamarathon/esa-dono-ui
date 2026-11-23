import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScheduleStrip from '../../src/components/ScheduleStrip';
import type { ScheduleRecentDonation } from '../../src/types';

vi.mock('../../src/api/schedule', () => ({ getSchedule: vi.fn() }));

import { getSchedule } from '../../src/api/schedule';

function renderStrip(path = '/wallet') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <button>elsewhere</button>
      <ScheduleStrip />
    </MemoryRouter>,
  );
}

const liveAndNext = {
  live: { game: 'Celeste', players: 'TGH' },
  next: { game: 'Super Metroid', players: 'Zoast' },
};

/** The fake clock every acknowledgement test starts from (#250 D9). */
const BASE_MS = new Date('2027-01-14T22:40:00.000Z').getTime();

function donation(over: Partial<ScheduleRecentDonation> = {}): ScheduleRecentDonation {
  return {
    id: 'd-1',
    display_name: 'Sam',
    amount_cents: 2500,
    created_at: new Date(BASE_MS + 10_000).toISOString(),
    ...over,
  };
}

/** Flush the initial load (and any pending microtasks) under fake timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ScheduleStrip', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "Live" and "Up next" with game and players', async () => {
    vi.mocked(getSchedule).mockResolvedValue(liveAndNext);

    renderStrip();

    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Up next')).toBeInTheDocument();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
    expect(screen.getByText('TGH')).toBeInTheDocument();
    expect(screen.getByText('Super Metroid')).toBeInTheDocument();
    expect(screen.getByText('Zoast')).toBeInTheDocument();
  });

  it('renders only "Live" while nothing is up next', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ live: liveAndNext.live, next: null });

    renderStrip();

    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Up next')).not.toBeInTheDocument();
  });

  it('truncates long names on one line instead of wrapping', async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      live: {
        game: 'A Really Long Game Name That Would Never Fit On A Narrow Screen',
        players: 'Some Runner With A Very Long Name',
      },
      next: null,
    });

    renderStrip();

    const strip = await screen.findByTestId('schedule-strip');
    const row = strip.firstElementChild!;
    expect(row.className).toContain('h-10');
    expect(row.className).toContain('overflow-hidden');
    expect(row.className).toContain('whitespace-nowrap');
    expect(screen.getByText(/A Really Long Game Name/).className).toContain('truncate');
    expect(screen.getByText(/Some Runner With A Very Long Name/).className).toContain('truncate');
  });

  it.each([
    ['no configured slug (D6)', { live: null, next: null }],
    ['ended schedule (D6)', { live: null, next: null }],
    ['ambiguous active Events (D7)', { live: null, next: null }],
  ])('renders nothing at all for %s', async (_label, response) => {
    vi.mocked(getSchedule).mockResolvedValue(response);

    const { container } = renderStrip();
    await act(async () => {});

    expect(container.querySelector('[data-testid="schedule-strip"]')).toBeNull();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('renders nothing at all when the schedule read fails', async () => {
    vi.mocked(getSchedule).mockRejectedValue(new Error('offline'));

    const { container } = renderStrip();
    await act(async () => {});

    expect(container.querySelector('[data-testid="schedule-strip"]')).toBeNull();
  });

  it('is hidden on the homepage', async () => {
    vi.mocked(getSchedule).mockResolvedValue(liveAndNext);

    const { container } = renderStrip('/');

    await act(async () => {});
    expect(container.querySelector('[data-testid="schedule-strip"]')).toBeNull();
  });

  it('keeps a fixed height, no focusable controls and aria-live off', async () => {
    vi.mocked(getSchedule).mockResolvedValue(liveAndNext);

    renderStrip();

    const strip = await screen.findByTestId('schedule-strip');
    expect(strip.firstElementChild!.className).toContain('h-10');
    expect(strip.getAttribute('aria-live')).toBeNull();
    expect(strip.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(
      0,
    );
  });

  it('refreshes on the ~15 s poll without stealing focus', async () => {
    vi.useFakeTimers();
    vi.mocked(getSchedule)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        live: { game: 'Super Metroid', players: 'Zoast' },
        next: { game: 'Hollow Knight', players: 'fireb0rn' },
      });

    renderStrip();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Celeste')).toBeInTheDocument();

    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    expect(screen.getByText('Hollow Knight')).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('asks for the schedule of the Channel in context, else without a channel', async () => {
    vi.mocked(getSchedule).mockResolvedValue(liveAndNext);

    renderStrip('/donate/esa-2026/stream-1');
    expect(getSchedule).toHaveBeenCalledWith('stream-1');

    renderStrip('/wallet');
    expect(getSchedule).toHaveBeenCalledWith(undefined);
  });
});

describe('ScheduleStrip donation acknowledgements (#250)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an individual acknowledgement for one ~5 s slot, then the schedule (D4/D6)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() }),
        ],
      });

    renderStrip();
    await flush();
    expect(screen.getByText('Celeste')).toBeInTheDocument();

    // A donation created during the visit arrives with the next poll.
    await advance(15000);
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();
    // The ack replaces the schedule text in place (D2/D6).
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.queryByText('Celeste')).not.toBeInTheDocument();

    await advance(4999);
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();

    await advance(1);
    expect(screen.queryByTestId('donation-ack')).toBeNull();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('renders the mapped "Anonymous" name for blank or hidden donations (D2/D5)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-anon', display_name: 'Anonymous', amount_cents: 1000 }),
        ],
      });

    renderStrip();
    await flush();
    await advance(15000);

    expect(screen.getByText('Anonymous donated $10.00')).toBeInTheDocument();
  });

  it('renders cents when nonzero and no forced decimals otherwise (derived item 2)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [donation({ id: 'd-1', amount_cents: 2550 })],
      });

    renderStrip();
    await flush();
    await advance(15000);

    expect(screen.getByText('Sam donated $25.50')).toBeInTheDocument();
  });

  it('never renders the donor comment (D4)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          {
            ...donation({ id: 'd-1' }),
            comment: 'A very long donor comment that must never show in the strip',
          } as ScheduleRecentDonation,
        ],
      });

    renderStrip();
    await flush();
    await advance(15000);

    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();
    expect(
      screen.queryByText('A very long donor comment that must never show in the strip'),
    ).toBeNull();
  });

  it('shows "N donations in the last minute" when the window holds 2+ (D6)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() }),
        ],
      })
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() }),
          donation({
            id: 'd-2',
            display_name: 'Riley',
            amount_cents: 550,
            created_at: new Date(BASE_MS + 25_000).toISOString(),
          }),
        ],
      });

    renderStrip();
    await flush();
    await advance(15000);
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();

    await advance(15000);
    expect(screen.getByText('2 donations in the last minute')).toBeInTheDocument();
    expect(screen.queryByText('Sam donated $25.00')).toBeNull();
  });

  it('re-shows the aggregate only when another donation arrives (D7)', async () => {
    const d1 = donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() });
    const d2 = donation({
      id: 'd-2',
      display_name: 'Riley',
      amount_cents: 550,
      created_at: new Date(BASE_MS + 25_000).toISOString(),
    });
    const d3 = donation({
      id: 'd-3',
      display_name: 'Kim',
      amount_cents: 1500,
      created_at: new Date(BASE_MS + 55_000).toISOString(),
    });
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1] })
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1, d2] })
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1, d2] })
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1, d2, d3] });

    renderStrip();
    await flush();
    await advance(15000); // d1: individual ack
    await advance(15000); // d2: aggregate "2 donations in the last minute"
    expect(screen.getByText('2 donations in the last minute')).toBeInTheDocument();

    await advance(15000); // same window, no new donation: the count is not re-shown
    expect(screen.queryByTestId('donation-ack')).toBeNull();
    expect(screen.getByText('Celeste')).toBeInTheDocument();

    await advance(15000); // d3 arrives while the window holds 3: aggregate again
    expect(screen.getByText('3 donations in the last minute')).toBeInTheDocument();
  });

  it('acknowledges each donation at most once per visit (D6)', async () => {
    const d1 = donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() });
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1] })
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1] });

    renderStrip();
    await flush();
    await advance(15000);
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();

    await advance(5000); // the slot ends
    expect(screen.queryByTestId('donation-ack')).toBeNull();

    await advance(10000); // the same donation is observed again: never re-acked
    expect(screen.queryByTestId('donation-ack')).toBeNull();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
  });

  it('never acknowledges donations created before the load (D9)', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-old', created_at: new Date(BASE_MS - 120_000).toISOString() }),
          donation({ id: 'd-at-load', created_at: new Date(BASE_MS).toISOString() }),
        ],
      });

    renderStrip();
    await flush();
    await advance(15000);
    await advance(15000);

    expect(screen.queryByTestId('donation-ack')).toBeNull();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
  });

  it('behaves like a fresh load after a reconnect: no catch-up (D9)', async () => {
    const d1 = donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() });
    const d2 = donation({
      id: 'd-2',
      display_name: 'Riley',
      amount_cents: 550,
      created_at: new Date(BASE_MS + 40_000).toISOString(),
    });
    const d3 = donation({
      id: 'd-3',
      display_name: 'Kim',
      amount_cents: 1500,
      created_at: new Date(BASE_MS + 55_000).toISOString(),
    });
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d1, d2] })
      .mockResolvedValueOnce({ ...liveAndNext, recent_donations: [d2, d3] });

    renderStrip();
    await flush();
    await advance(15000); // d1 acknowledged
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();

    await advance(15000); // the read fails: the strip renders nothing
    expect(screen.queryByTestId('schedule-strip')).toBeNull();

    await advance(15000); // reconnect: d2 arrived while offline — never acknowledged
    expect(screen.getByText('Celeste')).toBeInTheDocument();
    expect(screen.queryByTestId('donation-ack')).toBeNull();

    await advance(15000); // d3 is newer than the reconnect: acknowledged
    expect(screen.getByText('Kim donated $15.00')).toBeInTheDocument();
  });

  it('stays schedule-only when the response carries no donation data (D11)', async () => {
    vi.mocked(getSchedule).mockResolvedValue(liveAndNext);

    renderStrip();
    await flush();
    await advance(15000);
    await advance(15000);

    expect(screen.queryByTestId('donation-ack')).toBeNull();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
  });

  it('keeps the fixed height, aria-live off, no focusables and no focus theft during an ack', async () => {
    vi.mocked(getSchedule)
      .mockResolvedValue(liveAndNext)
      .mockResolvedValueOnce(liveAndNext)
      .mockResolvedValueOnce({
        ...liveAndNext,
        recent_donations: [
          donation({ id: 'd-1', created_at: new Date(BASE_MS + 10_000).toISOString() }),
        ],
      });

    renderStrip();
    await flush();

    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    await advance(15000); // the ack replaces the schedule

    const strip = screen.getByTestId('schedule-strip');
    expect(screen.getByText('Sam donated $25.00')).toBeInTheDocument();
    expect(strip.firstElementChild!.className).toContain('h-10');
    expect(strip.getAttribute('aria-live')).toBeNull();
    expect(strip.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(
      0,
    );
    expect(document.activeElement).toBe(elsewhere);

    await advance(5000); // back to the schedule: height and focus unchanged
    expect(strip.firstElementChild!.className).toContain('h-10');
    expect(document.activeElement).toBe(elsewhere);
  });
});
