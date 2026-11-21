import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Help from '../../src/pages/Help';

describe('Help page', () => {
  it('anchors the your data (gdpr) section for the checkout link (#81)', () => {
    render(<Help />);
    expect(document.getElementById('your-data-gdpr')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'your data (gdpr)' })).toBeInTheDocument();
  });

  it('discloses the email promise and the full send list in your data (gdpr) (#81)', () => {
    render(<Help />);
    expect(
      screen.getByText(
        /We never use your email for marketing, never sell it, and share it only with Stripe, our payment processor\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Beyond your donation, we may also email you an auction offer if you win a bid, or a sign-in link if you request one\./,
      ),
    ).toBeInTheDocument();
  });
});
