import { Link } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import ProgressBar from '../components/ProgressBar';
import LoadingSpinner from '../components/LoadingSpinner';

function fmt(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

export default function Home() {
  const { campaign, raisedCents, goalCents, error } = useCampaign();

  if (error)
    return (
      <div className="p-8" style={{ color: 'var(--red)' }}>
        {error}
      </div>
    );
  if (!campaign) return <LoadingSpinner />;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="text-center mb-8">
        <p className="font-mono text-[10px] font-bold tracking-[0.35em] uppercase text-d-yellow mb-2">
          European Speedrunner Assembly
        </p>
        <h1 className="font-display text-5xl uppercase text-off-white mb-2">
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
            {fmt(raisedCents)} / {fmt(goalCents)}
          </span>
        </div>
        <ProgressBar value={raisedCents} max={goalCents} />
        <p className="text-center font-data text-sm text-off-white/55 mt-2">
          {goalCents > 0 ? `${Math.round((raisedCents / goalCents) * 100)}% of goal` : ''}
        </p>

        {/* Primary CTA — incentive cart wizard */}
        <Link
          to="/donate"
          className="inline-block mt-6 w-full text-center font-display text-2xl tracking-wide uppercase text-black no-underline py-4 px-6 rounded-sm transition-opacity hover:opacity-90"
          style={{ background: 'var(--d-yellow)' }}
        >
          contribute now
        </Link>
      </div>
    </div>
  );
}
