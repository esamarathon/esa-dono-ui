import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InfoTip from '../../src/components/InfoTip';

const TEXT =
  'We use your email to identify your donation, take payment through Stripe, and send your donation email — the link in it unlocks your wallet. We never use it for marketing, never sell it, and share it only with Stripe.';

describe('InfoTip', () => {
  it('exposes the tooltip text as the aria-label and keeps the tooltip non-interactive', () => {
    render(<InfoTip text={TEXT} />);
    expect(screen.getByLabelText(TEXT)).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent(TEXT);
    // No link: the tooltip must never trap the cursor.
    expect(screen.getByRole('tooltip').className).toContain('pointer-events-none');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('hosts a clickable link whose label extends the aria-label (#81)', () => {
    render(<InfoTip text={TEXT} link={{ href: '/help#your-data-gdpr', label: 'More in Help' }} />);
    const link = screen.getByRole('link', { name: 'More in Help' });
    expect(link).toHaveAttribute('href', '/help#your-data-gdpr');
    expect(screen.getByLabelText(`${TEXT} More in Help`)).toBeInTheDocument();
    // A hosted link must be reachable with the pointer.
    expect(screen.getByRole('tooltip').className).not.toContain('pointer-events-none');
    expect(screen.getByRole('tooltip')).toHaveTextContent('More in Help');
  });
});
