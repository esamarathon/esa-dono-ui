import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Channel } from '../types';
import moderatorClient from '../api/moderator';

const STORAGE_KEY = 'moderator_channel_filter';

interface ModeratorChannelFilterContextValue {
  channels: Channel[];
  selectedChannelId: string | null;
  setSelectedChannelId: (id: string | null) => void;
}

const ModeratorChannelFilterContext = createContext<ModeratorChannelFilterContextValue | null>(
  null,
);

export function useModeratorChannelFilter() {
  const ctx = useContext(ModeratorChannelFilterContext);
  if (!ctx) {
    throw new Error('useModeratorChannelFilter must be used within ModeratorChannelFilterProvider');
  }
  return ctx;
}

export function ModeratorChannelFilterProvider({ children }: { children: ReactNode }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === '' || raw === 'null' || raw === null ? null : raw;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    moderatorClient.get('/channels').then((r) => setChannels(r.data));
  }, []);

  const persist = (id: string | null) => {
    setSelectedChannelId(id);
    try {
      if (id === null) {
        localStorage.setItem(STORAGE_KEY, 'null');
      } else {
        localStorage.setItem(STORAGE_KEY, id);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <ModeratorChannelFilterContext.Provider
      value={{ channels, selectedChannelId, setSelectedChannelId: persist }}
    >
      {children}
    </ModeratorChannelFilterContext.Provider>
  );
}
