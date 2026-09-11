import { useEffect, useState } from 'react';
import client from '../api/client';

type BroadcastLevel = 'INFO' | 'WARNING' | 'CRITICAL' | null;

interface BroadcastData {
  message: string | null;
  level?: BroadcastLevel;
}

// level → style map (#68). `null`/undefined renders the original fixed style
// unchanged, so the banner remains non-breaking for existing broadcasts.
const LEVEL_STYLES: Record<
  string,
  { background: string; borderBottom: string; color: string; fontWeight?: number }
> = {
  default: {
    background:
      'linear-gradient(90deg, rgba(216, 226, 71, 0.15) 0%, rgba(216, 226, 71, 0.05) 100%)',
    borderBottom: '1px solid rgba(216, 226, 71, 0.2)',
    color: 'var(--off-white)',
  },
  INFO: {
    background: 'linear-gradient(90deg, rgba(115, 78, 158, 0.2) 0%, rgba(115, 78, 158, 0.08) 100%)',
    borderBottom: '1px solid rgba(115, 78, 158, 0.3)',
    color: 'var(--off-white)',
  },
  WARNING: {
    background: 'linear-gradient(90deg, rgba(253, 187, 28, 0.25) 0%, rgba(253, 187, 28, 0.1) 100%)',
    borderBottom: '1px solid rgba(253, 187, 28, 0.4)',
    color: 'var(--off-white)',
    fontWeight: 600,
  },
  CRITICAL: {
    background:
      'linear-gradient(90deg, rgba(252, 28, 103, 0.35) 0%, rgba(252, 28, 103, 0.15) 100%)',
    // #fc1c67 (--red) instead of the var() form — jsdom/cssstyle fails to
    // parse a border shorthand containing var() when it follows a
    // multi-stop gradient background, silently dropping the computed style
    // (see BroadcastBanner.test.tsx). The rendered color is identical.
    borderBottom: '2px solid #fc1c67',
    color: 'var(--off-white)',
    fontWeight: 700,
  },
};

export default function BroadcastBanner() {
  const [broadcast, setBroadcast] = useState<BroadcastData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const response = await client.get('/campaign/broadcast');
        setBroadcast(response.data);
      } catch (e) {
        console.error('Failed to load broadcast:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || !broadcast?.message) return null;

  const style = LEVEL_STYLES[broadcast.level ?? 'default'];

  return (
    <div className="px-4 py-3 text-sm text-center font-body whitespace-pre-line" style={style}>
      {broadcast.message}
    </div>
  );
}
