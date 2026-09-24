import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getCampaign } from '../api/campaign';
import { CAMPAIGN_POLL_MS } from '../config';
import type { Campaign } from '../types';

interface CampaignContextValue {
  campaign: Campaign | null;
  raisedCents: number;
  goalCents: number;
  error: string | null;
  refreshCampaign: () => Promise<void>;
}

const CampaignContext = createContext<CampaignContextValue | null>(null);

export function CampaignProvider({ children }: { children: ReactNode }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const c = await getCampaign();
      setCampaign(c);
      setError(null);
    } catch {
      setError('Failed to load campaign data.');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, CAMPAIGN_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const raisedCents = campaign?.amount_raised?.value
    ? Math.round(parseFloat(campaign.amount_raised.value) * 100)
    : campaign?.total_amount_raised?.value
      ? Math.round(parseFloat(campaign.total_amount_raised.value) * 100)
      : 0;

  const goalCents = campaign?.goal?.value
    ? Math.round(parseFloat(campaign.goal.value) * 100)
    : campaign?.fundraising_goal?.value
      ? Math.round(parseFloat(campaign.fundraising_goal.value) * 100)
      : 0;

  return (
    <CampaignContext.Provider
      value={{
        campaign,
        raisedCents,
        goalCents,
        error,
        refreshCampaign: load,
      }}
    >
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  const context = useContext(CampaignContext);
  if (!context) {
    throw new Error('useCampaign must be used within a CampaignProvider');
  }
  return context;
}
