import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Event } from '../types';
import moderatorClient from '../api/moderator';

const STORAGE_KEY = 'moderator_event_filter';

interface ModeratorEventFilterContextValue {
  events: Event[];
  selectedEventId: string | null;
  setSelectedEventId: (id: string | null) => void;
}

const ModeratorEventFilterContext = createContext<ModeratorEventFilterContextValue | null>(null);

export function useModeratorEventFilter() {
  const ctx = useContext(ModeratorEventFilterContext);
  if (!ctx) {
    throw new Error('useModeratorEventFilter must be used within ModeratorEventFilterProvider');
  }
  return ctx;
}

export function ModeratorEventFilterProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === '' || raw === 'null' || raw === null ? null : raw;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    moderatorClient.get('/events').then((r) => setEvents(r.data));
  }, []);

  const persist = (id: string | null) => {
    setSelectedEventId(id);
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
    <ModeratorEventFilterContext.Provider
      value={{ events, selectedEventId, setSelectedEventId: persist }}
    >
      {children}
    </ModeratorEventFilterContext.Provider>
  );
}
