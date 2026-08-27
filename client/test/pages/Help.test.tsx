import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import Help from '../../src/pages/Help';

describe('Help', () => {
  it('renders the help sections', () => {
    render(<Help />);

    expect(screen.getByRole('heading', { name: 'help' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'incentive types & categories' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'wallet & payments' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'refunds' })).toBeInTheDocument();
  });
});
