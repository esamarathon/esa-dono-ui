import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from '../../src/pages/Home';

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

describe('Home page', () => {
  it('shows the static hero: name, description, logo and the donate CTA', () => {
    renderHome();

    expect(screen.getByRole('heading', { name: 'ESA Charity Marathon' })).toBeInTheDocument();
    expect(
      screen.getByText(/A charity speedrunning channel raising money for a great cause/),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'ESA emblem' })).toHaveAttribute(
      'src',
      '/brand/emblem-dark.svg',
    );
    expect(screen.getByRole('link', { name: 'Donate now' })).toHaveAttribute('href', '/donate');
  });

  it('shows no raised amount, progress bar or "% of goal" (#148)', () => {
    const { container } = renderHome();

    expect(screen.queryByText(/Raised/)).not.toBeInTheDocument();
    expect(screen.queryByText(/% of goal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$[\d,]+/)).not.toBeInTheDocument();
    expect(container.querySelector('canvas, progress, [role="progressbar"]')).toBeNull();
  });
});
