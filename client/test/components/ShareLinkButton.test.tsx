import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ShareLinkButton from '../../src/components/ShareLinkButton';

describe('ShareLinkButton', () => {
  const originalClipboard = navigator.clipboard;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    vi.useRealTimers();
  });

  it('uses the required label prop as both title and accessible name (#80 D3)', () => {
    const label = 'Copy a link to this poll';
    render(<ShareLinkButton path="/polls?poll=p1" label={label} />);

    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveAttribute('title', label);
    expect(button).toHaveAttribute('aria-label', label);
  });

  it('copies the full permalink to the clipboard and shows a Copied! confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com' },
      writable: true,
    });

    const label = 'Copy a link that starts a donation with this reward selected';
    render(<ShareLinkButton path="/rewards?reward=r1" label={label} />);
    fireEvent.click(screen.getByRole('button', { name: label }));

    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://example.com/rewards?reward=r1');
    const copied = screen.getByText('Copied!');
    // The confirmation is render-sized (#80 D2): text-sm, never text-xs.
    expect(copied).toHaveClass('text-sm');

    // Confirmation resets after the timeout.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('does not crash or show confirmation when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    const label = 'Copy a link that starts a donation with this goal selected';
    render(<ShareLinkButton path="/goals?goal=g1" label={label} />);
    fireEvent.click(screen.getByRole('button', { name: label }));

    await act(async () => {});
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });
});
