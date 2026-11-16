import { useModeratorKeyGate } from '../../hooks/useKeyGate';
import SidebarLayout, { type SidebarNavGroup } from '../../components/SidebarLayout';
import StaffLoginCard from '../../components/StaffLoginCard';
import { StaffSidebarFooterBody } from '../../components/StaffSidebarFooter';
import {
  DashboardIcon,
  PollIcon,
  GiftIcon,
  GoalIcon,
  CheckBadgeIcon,
  MoneyIcon,
  PlayIcon,
  AuctionIcon,
  ShareIcon,
  InfoIcon,
} from '../../components/icons';
import {
  ModeratorChannelFilterProvider,
  useModeratorChannelFilter,
} from '../../context/ModeratorChannelFilterContext';

// Grouped staff navigation (#238), mirroring the admin grouping minus the
// admin-only sections. Same route set as before.
const NAV_GROUPS: SidebarNavGroup[] = [
  {
    heading: 'overview',
    items: [{ to: '/moderate', label: 'dashboard', end: true, icon: DashboardIcon }],
  },
  {
    heading: 'event content',
    items: [
      { to: '/moderate/events', label: 'events', icon: PlayIcon },
      { to: '/moderate/channels', label: 'channels', icon: ShareIcon },
      { to: '/moderate/polls', label: 'polls', icon: PollIcon },
      { to: '/moderate/rewards', label: 'rewards', icon: GiftIcon },
      { to: '/moderate/goals', label: 'goals', icon: GoalIcon },
      { to: '/moderate/auctions', label: 'auctions', icon: AuctionIcon },
    ],
  },
  {
    heading: 'money',
    items: [
      { to: '/moderate/claims', label: 'claims', icon: CheckBadgeIcon },
      { to: '/moderate/unused-pool-money', label: 'unused pool money', icon: GoalIcon },
      { to: '/moderate/donations', label: 'donations', icon: MoneyIcon },
    ],
  },
  {
    heading: 'support',
    items: [{ to: '/moderate/help', label: 'help', icon: InfoIcon }],
  },
];

export default function ModeratorLayout() {
  // Key and session handling is shared with the admin layout: a key is
  // validated before it is persisted and before the dashboard renders (#136).
  const { access, error, input, setInput, pending, key, login, logout } = useModeratorKeyGate();

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <StaffLoginCard
        title="moderator login"
        blurb="Log in with your donor magic link for moderator/admin access, or enter a moderator key below."
        input={input}
        onInput={setInput}
        onSubmit={login}
        pending={pending}
        error={error}
        placeholder="Enter moderator key"
      />
    );
  }

  return (
    <ModeratorChannelFilterProvider>
      <ModeratorLayoutInner keyValue={key} onLogout={logout} />
    </ModeratorChannelFilterProvider>
  );
}

function ChannelFilterBar() {
  const { channels, selectedChannelId, setSelectedChannelId } = useModeratorChannelFilter();
  return (
    <div className="flex items-center gap-3">
      <label className="font-data text-sm text-off-white/55">channel filter</label>
      <select
        className="px-3 py-1.5 text-sm bg-transparent border border-off-white/20 rounded-sm"
        value={selectedChannelId ?? ''}
        onChange={(e) => setSelectedChannelId(e.target.value || null)}
      >
        <option value="">all channels</option>
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
      groups={NAV_GROUPS}
      storageKey="moderator_sidebar_collapsed"
      // #238: the channel filter lives in the location bar, next to the page
      // it applies to, instead of floating above every page.
      header={<ChannelFilterBar />}
      footer={(collapsed) => (
        <StaffSidebarFooterBody
          collapsed={collapsed}
          logout={onLogout}
          // Empty label hides the button: donor-session access has no key to
          // clear (unchanged behaviour). Label matches the admin layout.
          logoutLabel={keyValue ? 'logout' : ''}
        />
      )}
    />
  );
}
