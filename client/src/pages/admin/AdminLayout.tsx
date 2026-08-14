import { useState } from 'react';
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
  LogoutIcon,
} from '../../components/icons';

const NAV: SidebarNavItem[] = [
  { to: '/admin', label: 'dashboard', end: true, icon: DashboardIcon },
  { to: '/admin/donors', label: 'donors', icon: UsersIcon },
  { to: '/admin/rewards', label: 'rewards', icon: GiftIcon },
  { to: '/admin/polls', label: 'polls', icon: PollIcon },
  { to: '/admin/goals', label: 'goals', icon: GoalIcon },
  { to: '/admin/donations', label: 'donations & claims', icon: ReceiptIcon },
  { to: '/admin/pledges', label: 'pledges', icon: ClipboardIcon },
  { to: '/admin/blocked-words', label: 'blocked words', icon: BanIcon },
  { to: '/admin/simulate', label: 'simulate', icon: PlayIcon },
];

export default function AdminLayout() {
  const [key, setKey] = useState(localStorage.getItem('admin_key') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const isLoggedIn = !!key;

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
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="btrl-panel p-8 w-full max-w-sm">
          <h1 className="font-display text-3xl lowercase mb-4">admin login</h1>
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
        <button
          onClick={logout}
          title="logout"
          className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white mt-4 ${collapsed ? 'justify-center' : 'text-left'}`}
        >
          <LogoutIcon className="w-4 h-4 shrink-0" />
          {!collapsed && <span>logout</span>}
        </button>
      )}
    />
  );
}
