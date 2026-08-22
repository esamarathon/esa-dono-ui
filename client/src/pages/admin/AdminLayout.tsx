import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDonor } from '../../api/donor';
import { isSessionActive } from '../../utils/authToken';
import { hasAdminAccess } from '../../types';
import SidebarLayout, { type SidebarNavItem } from '../../components/SidebarLayout';
import {
  DashboardIcon,
  UsersIcon,
  GiftIcon,
  PollIcon,
  GoalIcon,
  ReceiptIcon,
  ClipboardIcon,
  BanIcon,
  PlayIcon,
  HomeIcon,
  LogoutIcon,
} from '../../components/icons';

const NAV: SidebarNavItem[] = [
  { to: '/admin', label: 'dashboard', end: true, icon: DashboardIcon },
  { to: '/admin/donors', label: 'donors', icon: UsersIcon },
  { to: '/admin/events', label: 'events', icon: PlayIcon },
  { to: '/admin/rewards', label: 'rewards', icon: GiftIcon },
  { to: '/admin/polls', label: 'polls', icon: PollIcon },
  { to: '/admin/goals', label: 'goals', icon: GoalIcon },
  { to: '/admin/donations', label: 'donations & claims', icon: ReceiptIcon },
  { to: '/admin/pledges', label: 'pledges', icon: ClipboardIcon },
  { to: '/admin/blocked-words', label: 'blocked words', icon: BanIcon },
  { to: '/admin/destinations', label: 'destinations', icon: PlayIcon },
  { to: '/admin/simulate', label: 'simulate', icon: PlayIcon },
];

type AccessState = 'checking' | 'granted' | 'denied';

export default function AdminLayout() {
  const [access, setAccess] = useState<AccessState>('checking');
  const [key, setKey] = useState(localStorage.getItem('admin_key') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // A stored admin key is treated as a valid path (actual API calls will
    // 401/403 if it's wrong). Otherwise, an ADMIN-role donor session grants
    // access (ADR 0003).
    if (key) {
      setAccess('granted');
      return;
    }
    if (!isSessionActive()) {
      setAccess('denied');
      return;
    }
    getDonor()
      .then((donor) => setAccess(hasAdminAccess(donor.role) ? 'granted' : 'denied'))
      .catch(() => setAccess('denied'));
  }, [key]);

  const login = () => {
    if (!input.trim()) {
      setError('Enter API key');
      return;
    }
    localStorage.setItem('admin_key', input.trim());
    setKey(input.trim());
    setError('');
  };

  const logout = () => {
    localStorage.removeItem('admin_key');
    setKey('');
    setAccess('checking');
  };

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="btrl-panel p-8 w-full max-w-sm">
          <h1 className="font-display text-3xl uppercase mb-4">admin login</h1>
          <p className="font-body text-sm text-off-white/55 mb-4">
            Sign in with an admin account from{' '}
            <Link to="/wallet" className="text-d-yellow hover:underline">
              your wallet
            </Link>
            , or enter the admin API key.
          </p>
          <input
            type="password"
            placeholder="Enter admin API key"
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
    <SidebarLayout
      title="admin"
      nav={NAV}
      storageKey="admin_sidebar_collapsed"
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
          <button
            onClick={logout}
            title="logout"
            className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white ${collapsed ? 'justify-center' : 'text-left'}`}
          >
            <LogoutIcon className="w-4 h-4 shrink-0" />
            {!collapsed && <span>logout</span>}
          </button>
        </div>
      )}
    />
  );
}
