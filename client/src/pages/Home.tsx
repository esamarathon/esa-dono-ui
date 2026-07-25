import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCampaign } from '../api/campaign';
import ProgressBar from '../components/ProgressBar';
import LoadingSpinner from '../components/LoadingSpinner';
import type { Campaign } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

export default function Home() {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCampaign()
      .then(setCampaign)
      .catch(() => setError('Failed to load campaign data.'));
  }, []);

  if (error)
    return (
      <div className="p-8" style={{ color: 'var(--red)' }}>
        {error}
      </div>
    );
  if (!campaign) return <LoadingSpinner />;

  const raised = campaign.amount_raised?.value
    ? Math.round(parseFloat(campaign.amount_raised.value) * 100)
    : campaign.total_amount_raised?.value
      ? Math.round(parseFloat(campaign.total_amount_raised.value) * 100)
      : 0;
  const goal = campaign.goal?.value
    ? Math.round(parseFloat(campaign.goal.value) * 100)
    : campaign.fundraising_goal?.value
      ? Math.round(parseFloat(campaign.fundraising_goal.value) * 100)
      : 0;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="text-center mb-8">
        <p className="font-mono text-[10px] font-bold tracking-[0.35em] uppercase text-d-yellow mb-2">
          European Speedrunner Assembly
        </p>
        <h1 className="font-display text-5xl lowercase text-off-white mb-2">
          {campaign.name ?? campaign.title ?? 'Campaign'}
        </h1>
      </div>
      {campaign.description && (
        <p className="text-off-white/55 mb-6 text-center font-body text-sm">
          {campaign.description}
        </p>
      )}
      {campaign.logo?.src && (
        <img src={campaign.logo.src} alt="Campaign logo" className="w-48 mb-6 rounded-sm mx-auto" />
      )}
      <div className="btrl-panel p-6">
        <div className="flex justify-between mb-2">
          <span className="font-data font-bold text-sm text-off-white/55">raised</span>
          <span className="font-data font-bold text-sm text-d-yellow">
            {fmt(raised)} / {fmt(goal)}
          </span>
        </div>
        <ProgressBar value={raised} max={goal} />
        <p className="text-center font-data text-sm text-off-white/55 mt-2">
          {goal > 0 ? `${Math.round((raised / goal) * 100)}% of goal` : ''}
        </p>

        {/* Primary CTA — incentive cart wizard */}
        <Link
          to="/donate"
          className="inline-block mt-6 w-full text-center font-display text-2xl tracking-wide lowercase text-black no-underline py-4 px-6 rounded-sm transition-opacity hover:opacity-90"
          style={{ background: 'var(--d-yellow)' }}
        >
          donate now
        </Link>

        {/* Secondary CTA — skip straight to Tiltify */}
        {campaign.donate_url && (
          <div className="mt-4 text-center">
            <a
              href={campaign.donate_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-data font-bold text-sm tracking-wider lowercase text-off-white/55 hover:text-off-white no-underline"
            >
              skip the incentives &rarr;
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
