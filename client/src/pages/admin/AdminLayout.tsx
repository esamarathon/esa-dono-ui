import { Link } from 'react-router-dom';
import { useAdminKeyGate } from '../../hooks/useKeyGate';
import SidebarLayout, { type SidebarNavGroup } from '../../components/SidebarLayout';
import StaffLoginCard from '../../components/StaffLoginCard';
import { StaffSidebarFooterBody } from '../../components/StaffSidebarFooter';
import {
  DashboardIcon,
  UsersIcon,
  GiftIcon,
  PollIcon,
  GoalIcon,
  ReceiptIcon,
  ShieldIcon,
  ChatIcon,
  SlidersIcon,
  BroadcastIcon,
  ShareIcon,
  MoneyIcon,
  PlusCircleIcon,
  AuctionIcon,
  PlayIcon,
  InfoIcon,
} from '../../components/icons';

// Grouped staff navigation (#238): sections give the 17 admin destinations a
// scannable hierarchy, and every item has its own icon so the collapsed rail
// stays unambiguous.
const NAV_GROUPS: SidebarNavGroup[] = [
  {
    heading: 'overview',
    items: [
      { to: '/admin', label: 'dashboard', end: true, icon: DashboardIcon },
      { to: '/admin/donors', label: 'donors', icon: UsersIcon },
    ],
  },
  {
    heading: 'event content',
    items: [
      { to: '/admin/events', label: 'events', icon: PlayIcon },
      { to: '/admin/channels', label: 'channels', icon: ShareIcon },
      { to: '/admin/rewards', label: 'rewards', icon: GiftIcon },
      { to: '/admin/polls', label: 'polls', icon: PollIcon },
      { to: '/admin/goals', label: 'goals', icon: GoalIcon },
      { to: '/admin/auctions', label: 'auctions', icon: AuctionIcon },
    ],
  },
  {
    heading: 'money',
    items: [
      { to: '/admin/donations', label: 'donations & claims', icon: MoneyIcon },
      { to: '/admin/pledges', label: 'pledges', icon: ReceiptIcon },
      { to: '/admin/add-donation', label: 'add donation', icon: PlusCircleIcon },
    ],
  },
  {
    heading: 'platform',
    items: [
      { to: '/admin/blocked-words', label: 'blocked words', icon: ShieldIcon },
      { to: '/admin/feedback', label: 'feedback', icon: ChatIcon },
      { to: '/admin/feature-flags', label: 'feature flags', icon: SlidersIcon },
      { to: '/admin/broadcast', label: 'broadcast banner', icon: BroadcastIcon },
      { to: '/admin/destinations', label: 'destinations', icon: ShareIcon },
    ],
  },
  {
    heading: 'support',
    items: [{ to: '/admin/help', label: 'help', icon: InfoIcon }],
  },
];

export default function AdminLayout() {
  // Key and session handling is shared with the moderator layout: a key is
  // validated before it is persisted and before the dashboard renders (#136).
  const { access, error, input, setInput, pending, login, logout } = useAdminKeyGate();

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <StaffLoginCard
        title="admin login"
        blurb={
          <>
            Sign in with an admin account from{' '}
            <Link to="/wallet" className="text-d-yellow hover:underline">
              your wallet
            </Link>
            , or enter the admin API key.
          </>
        }
        input={input}
        onInput={setInput}
        onSubmit={login}
        pending={pending}
        error={error}
        placeholder="Enter admin API key"
      />
    );
  }

  return (
    <SidebarLayout
      title="admin"
      groups={NAV_GROUPS}
      storageKey="admin_sidebar_collapsed"
      footer={(collapsed) => (
        <StaffSidebarFooterBody collapsed={collapsed} logout={logout} logoutLabel="logout" />
      )}
    />
  );
}
