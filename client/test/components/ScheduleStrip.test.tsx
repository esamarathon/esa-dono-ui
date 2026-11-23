import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScheduleStrip from '../../src/components/ScheduleStrip';

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

describe('ScheduleStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('refreshes on the ~60 s poll without stealing focus', async () => {
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
      await vi.advanceTimersByTimeAsync(60000);
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
