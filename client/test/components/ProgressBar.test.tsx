import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ProgressBar from '../../src/components/ProgressBar';

describe('ProgressBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the progress bar', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} />);
    const bar = container.querySelector('[data-testid="progress-fill"]') as HTMLElement;
    expect(bar).toBeDefined();
    expect(bar.style.width).toBe('50%');
  });

  it('caps at 100%', () => {
    const { container } = render(<ProgressBar value={15000} max={10000} />);
    const bar = container.querySelector('[data-testid="progress-fill"]') as HTMLElement;
    expect(bar.style.width).toBe('100%');
  });

  it('shows label when provided', () => {
    render(<ProgressBar value={5000} max={10000} label="$50 of $100" />);
    expect(screen.getByText('$50 of $100')).toBeDefined();
  });

  it('does not show label when not provided', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} />);
    expect(container.querySelector('.flex.justify-between')).toBeNull();
  });

  it('handles zero max', () => {
    const { container } = render(<ProgressBar value={0} max={0} />);
    const bar = container.querySelector('[data-testid="progress-fill"]') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });

  it('does not animate on initial render', () => {
    render(<ProgressBar value={5000} max={10000} />);
    expect(screen.queryByTestId('progress-animation')).toBeNull();
  });

  it('triggers coin and plus animation when value increases', () => {
    const { rerender } = render(<ProgressBar value={5000} max={10000} />);

    // Value increases by $20 (2000 cents)
    rerender(<ProgressBar value={7000} max={10000} />);

    const animationContainer = screen.getByTestId('progress-animation');
    expect(animationContainer).toBeDefined();
    expect(screen.getByText('+$20')).toBeDefined();

    // Fast-forward past animation timeout (1200ms)
    act(() => {
      vi.advanceTimersByTime(1300);
    });

    expect(screen.queryByTestId('progress-animation')).toBeNull();
  });

  it('does not trigger animation when value decreases', () => {
    const { rerender } = render(<ProgressBar value={5000} max={10000} />);

    rerender(<ProgressBar value={4000} max={10000} />);
    expect(screen.queryByTestId('progress-animation')).toBeNull();
  });

  it('honors animateOnChange=false', () => {
    const { rerender } = render(<ProgressBar value={5000} max={10000} animateOnChange={false} />);

    rerender(<ProgressBar value={7000} max={10000} animateOnChange={false} />);
    expect(screen.queryByTestId('progress-animation')).toBeNull();
  });

  it('shows a donation-impact preview overlay when previewPct exceeds the current fill (#52)', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} previewPct={75} />);
    const preview = container.querySelector('[data-testid="progress-preview"]') as HTMLElement;
    expect(preview).toBeDefined();
    expect(preview.style.width).toBe('75%');
  });

  it('does not show a preview overlay when previewPct is at or below the current fill', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} previewPct={50} />);
    expect(container.querySelector('[data-testid="progress-preview"]')).toBeNull();
  });

  it('does not show a preview overlay when previewPct is omitted', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} />);
    expect(container.querySelector('[data-testid="progress-preview"]')).toBeNull();
  });

  it('clamps previewPct to 100', () => {
    const { container } = render(<ProgressBar value={5000} max={10000} previewPct={140} />);
    const preview = container.querySelector('[data-testid="progress-preview"]') as HTMLElement;
    expect(preview.style.width).toBe('100%');
  });
});
