import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressBar from '../../src/components/ProgressBar';

describe('ProgressBar', () => {
  it('renders the progress bar', () => {
    const { container } = render(<ProgressBar value={50} max={100} />);
    const bar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(bar).toBeDefined();
    expect(bar.style.width).toBe('50%');
  });

  it('caps at 100%', () => {
    const { container } = render(<ProgressBar value={150} max={100} />);
    const bar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(bar.style.width).toBe('100%');
  });

  it('shows label when provided', () => {
    render(<ProgressBar value={50} max={100} label="$50 of $100" />);
    expect(screen.getByText('$50 of $100')).toBeDefined();
  });

  it('does not show label when not provided', () => {
    const { container } = render(<ProgressBar value={50} max={100} />);
    expect(container.querySelector('.flex.justify-between')).toBeNull();
  });

  it('handles zero max', () => {
    const { container } = render(<ProgressBar value={0} max={0} />);
    const bar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });
});
