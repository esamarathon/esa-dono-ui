import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDonor } from '../../api/donor';
import { isSessionActive } from '../../utils/authToken';
import { hasModeratorAccess } from '../../types';
import SidebarLayout, { type SidebarNavItem } from '../../components/SidebarLayout';
import {
  DashboardIcon,
  PollIcon,
  GiftIcon,
  GoalIcon,
  CheckBadgeIcon,
  ReceiptIcon,
  PlayIcon,
  HomeIcon,
  LogoutIcon,
} from '../../components/icons';
import {
  ModeratorChannelFilterProvider,
  useModeratorChannelFilter,
} from '../../context/ModeratorChannelFilterContext';

const NAV: SidebarNavItem[] = [
  { to: '/moderate', label: 'dashboard', end: true, icon: DashboardIcon },
  { to: '/moderate/events', label: 'events', icon: PlayIcon },
  { to: '/moderate/polls', label: 'polls', icon: PollIcon },
  { to: '/moderate/rewards', label: 'rewards', icon: GiftIcon },
  { to: '/moderate/goals', label: 'goals', icon: GoalIcon },
  { to: '/moderate/claims', label: 'claims', icon: CheckBadgeIcon },
  { to: '/moderate/donations', label: 'donations', icon: ReceiptIcon },
];

type AccessState = 'checking' | 'granted' | 'denied';

export default function ModeratorLayout() {
  const [access, setAccess] = useState<AccessState>('checking');
  const [key, setKey] = useState(localStorage.getItem('moderator_key') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // A stored moderator key is treated as a valid fallback (mirrors admin
    // key behavior) — actual API calls will 401/403 if it's wrong.
    if (key) {
      setAccess('granted');
      return;
    }
    const donorSession = isSessionActive();
    if (!donorSession) {
      setAccess('denied');
      return;
    }
    getDonor()
      .then((donor) => setAccess(hasModeratorAccess(donor.role) ? 'granted' : 'denied'))
      .catch(() => setAccess('denied'));
  }, [key]);

  const login = () => {
    if (!input.trim()) {
      setError('Enter moderator key');
      return;
    }
    localStorage.setItem('moderator_key', input.trim());
    setKey(input.trim());
    setError('');
  };

  const logout = () => {
    localStorage.removeItem('moderator_key');
    setKey('');
    setAccess('checking');
  };

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="btrl-panel p-8 w-full max-w-sm">
          <h1 className="font-display text-3xl uppercase mb-2">moderator login</h1>
          <p className="font-data text-sm text-off-white/55 mb-4">
            Log in with your donor magic link for moderator/admin access, or enter a moderator key
            below.
          </p>
          <input
            type="password"
            placeholder="Enter moderator key"
            className="w-full px-3 py-2 mb-3 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
          />
          {error && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
          <button onClick={login} className="btrl-button w-full">
            login
          </button>
        </div>
      </div>
    );
  }

  return (
    <ModeratorChannelFilterProvider>
      <ModeratorLayoutInner keyValue={key} onLogout={logout} />
    </ModeratorChannelFilterProvider>
  );
}

function EventFilterBar() {
  const { channels, selectedChannelId, setSelectedChannelId } = useModeratorChannelFilter();
  return (
    <div className="mb-6 flex items-center gap-3">
      <label className="font-data text-sm text-off-white/55">event filter</label>
      <select
        className="px-3 py-1.5 text-sm bg-transparent border border-off-white/20 rounded-sm"
        value={selectedChannelId ?? ''}
        onChange={(e) => setSelectedChannelId(e.target.value || null)}
      >
        <option value="">all events</option>
        {channels.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModeratorLayoutInner({ keyValue, onLogout }: { keyValue: string; onLogout: () => void }) {
  return (
    <SidebarLayout
      title="moderator"
      nav={NAV}
      storageKey="moderator_sidebar_collapsed"
      header={<EventFilterBar />}
      footer={(collapsed) => (
        <div className="flex flex-col">
          <Link
            to="/"
            title="back to home"
            className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${collapsed ? 'justify-center' : 'text-left'}`}
          >
            <HomeIcon className="w-4 h-4 shrink-0" />
            {!collapsed && <span>back to home</span>}
          </Link>
          {keyValue ? (
            <button
              onClick={onLogout}
              title="logout (moderator key)"
              className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white ${collapsed ? 'justify-center' : 'text-left'}`}
            >
              <LogoutIcon className="w-4 h-4 shrink-0" />
              {!collapsed && <span>logout (moderator key)</span>}
            </button>
          ) : null}
        </div>
      )}
    />
  );
}
