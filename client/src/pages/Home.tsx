import { Link } from 'react-router-dom';

/**
 * Static homepage identity (#148): the public aggregate total, goal bar and
 * "% of goal" retired with GET /api/campaign (the stream overlay owns the
 * public fundraising display). The name and description moved here from the
 * retired server stub (server/routes/campaign.ts).
 */
const CAMPAIGN_NAME = 'ESA Charity Marathon';
const CAMPAIGN_DESCRIPTION =
  'A charity speedrunning channel raising money for a great cause. Watch runners tackle games at incredible speeds while supporting charity!';

export default function Home() {
  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="text-center mb-8">
        <p className="font-mono text-sm font-bold tracking-[0.35em] uppercase text-d-yellow mb-2">
          European Speedrunner Assembly
        </p>
        <h1 className="font-display text-5xl uppercase text-off-white mb-2">{CAMPAIGN_NAME}</h1>
      </div>
      <p className="text-off-white/55 mb-6 text-center font-body text-sm">{CAMPAIGN_DESCRIPTION}</p>
      <img src="/brand/emblem-dark.svg" alt="ESA emblem" className="w-48 mb-6 rounded-sm mx-auto" />
      <div className="btrl-panel p-6 text-center">
        {/* Primary CTA — incentive cart wizard */}
        <Link
          to="/donate"
          className="inline-block w-full text-center font-display text-2xl tracking-wide uppercase text-black no-underline py-4 px-6 rounded-sm transition-opacity hover:opacity-90"
          style={{ background: 'var(--d-yellow)' }}
        >
          Donate now
        </Link>
      </div>
    </div>
  );
}
