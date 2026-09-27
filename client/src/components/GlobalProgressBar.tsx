import { useLocation } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import ProgressBar from './ProgressBar';

function fmt(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

export default function GlobalProgressBar() {
  const { raisedCents, goalCents, campaign } = useCampaign();
  const location = useLocation();

  // The homepage already shows its own hero progress bar, so showing this
  // one too would be redundant.
  if (location.pathname === '/') {
    return null;
  }

  // If campaign isn't loaded yet or has no goal/raised data, don't show an empty bar
  if (!campaign && goalCents === 0 && raisedCents === 0) {
    return null;
  }

  const pct = goalCents > 0 ? Math.min(100, Math.round((raisedCents / goalCents) * 100)) : 0;

  return (
    <div
      className="border-b px-6 py-2 transition-colors"
      style={{
        background: 'rgba(25, 25, 25, 0.95)',
        borderColor: 'rgba(239, 238, 236, 0.08)',
      }}
      data-testid="global-progress-bar"
    >
      <div className="max-w-6xl mx-auto">
        <ProgressBar
          value={raisedCents}
          max={goalCents}
          label={
            <>
              <span className="font-data font-bold text-xs uppercase tracking-wider text-off-white/70">
                Campaign Progress
              </span>
              <span className="font-data font-bold text-xs text-d-yellow">
                {fmt(raisedCents)} / {fmt(goalCents)} ({pct}%)
              </span>
            </>
          }
        />
      </div>
    </div>
  );
}
