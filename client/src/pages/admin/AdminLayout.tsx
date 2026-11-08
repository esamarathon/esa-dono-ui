import { Link } from 'react-router-dom';
import { useAdminKeyGate } from '../../hooks/useKeyGate';
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
  InfoIcon,
  BroadcastIcon,
} from '../../components/icons';

const NAV: SidebarNavItem[] = [
  { to: '/admin', label: 'dashboard', end: true, icon: DashboardIcon },
  { to: '/admin/donors', label: 'donors', icon: UsersIcon },
  { to: '/admin/events', label: 'events', icon: PlayIcon },
  { to: '/admin/channels', label: 'channels', icon: PlayIcon },
  { to: '/admin/rewards', label: 'rewards', icon: GiftIcon },
  { to: '/admin/polls', label: 'polls', icon: PollIcon },
  { to: '/admin/goals', label: 'goals', icon: GoalIcon },
  { to: '/admin/auctions', label: 'auctions', icon: GiftIcon },
  { to: '/admin/donations', label: 'donations & claims', icon: ReceiptIcon },
  { to: '/admin/pledges', label: 'pledges', icon: ClipboardIcon },
  { to: '/admin/blocked-words', label: 'blocked words', icon: BanIcon },
  { to: '/admin/feature-flags', label: 'feature flags', icon: PlayIcon },
  { to: '/admin/broadcast', label: 'broadcast banner', icon: BroadcastIcon },
  { to: '/admin/destinations', label: 'destinations', icon: PlayIcon },
  { to: '/admin/simulate', label: 'add donation', icon: PlayIcon },
  { to: '/admin/help', label: 'help', icon: InfoIcon },
];

export default function AdminLayout() {
  // Key and session handling is shared with the moderator layout: a key is
  // validated before it is persisted and before the dashboard renders (#136).
  const { access, error, input, setInput, pending, login, logout } = useAdminKeyGate();

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
          <button onClick={login} disabled={pending} className="btrl-button w-full">
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
            className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${collapsed ? 'justify-center' : 'text-left'}`}
          >
            <HomeIcon className="w-4 h-4 shrink-0" />
            {!collapsed && <span>back to home</span>}
          </Link>
          <button
            onClick={logout}
            title="logout"
            className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white ${collapsed ? 'justify-center' : 'text-left'}`}
          >
            <LogoutIcon className="w-4 h-4 shrink-0" />
            {!collapsed && <span>logout</span>}
          </button>
        </div>
      )}
    />
  );
}
