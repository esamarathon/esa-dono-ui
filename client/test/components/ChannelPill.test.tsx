import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import ChannelPill from '../../src/components/ChannelPill';

describe('ChannelPill', () => {
  it('renders the label', () => {
    render(<ChannelPill label="Main" />);

    expect(screen.getByText('Main')).toBeInTheDocument();
  });
});
