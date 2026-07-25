import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Card from '../../src/components/Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Hello World</Card>);
    expect(screen.getByText('Hello World')).toBeDefined();
  });

  it('applies default classes', () => {
    const { container } = render(<Card>Test</Card>);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('btrl-panel');
  });

  it('merges custom className', () => {
    const { container } = render(<Card className="custom-class">Test</Card>);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('custom-class');
    expect(div.className).toContain('btrl-panel');
  });
});
