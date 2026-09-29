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
    vi.useRealTimers();
  });

  it('copies the full permalink to the clipboard and shows confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com' },
      writable: true,
    });

    render(<ShareLinkButton path="/rewards?reward=r1" />);
    const button = screen.getByRole('button', { name: 'Share' });

    fireEvent.click(button);

    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://example.com/rewards?reward=r1');
    expect(screen.getByText('copied!')).toBeInTheDocument();

    // Confirmation resets after the timeout.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('copied!')).not.toBeInTheDocument();
  });

  it('does not crash or show confirmation when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    render(<ShareLinkButton path="/goals?goal=g1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await act(async () => {});
    expect(screen.queryByText('copied!')).not.toBeInTheDocument();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });
});
