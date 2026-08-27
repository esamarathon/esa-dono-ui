import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { track } from '../lib/tracing';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { CheckBadgeIcon } from '../components/icons';
import RewardList from '../components/incentives/RewardList';
import PollList from '../components/incentives/PollList';
import GoalList from '../components/incentives/GoalList';

const TABS = ['rewards', 'polls', 'goals'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  rewards: 'rewards',
  polls: 'polls',
  goals: 'fund goals',
};

/** Map a pathname to the tab it should activate. /donate (and anything else
 * under the public tree) defaults to rewards — the same default the old
 * stepper's first step used. */
function tabFromPathname(pathname: string): Tab {
  if (pathname.startsWith('/polls')) return 'polls';
  if (pathname.startsWith('/goals')) return 'goals';
  return 'rewards';
}

export default function DonateFlow() {
  const {
    loading,
    openDrawer,
    hasVisited,
    channels,
    selectedChannelId,
    selectChannel,
    pendingChannelId,
    confirmChannelSwitch,
    cancelChannelSwitch,
  } = useCart();
  const location = useLocation();

  const [tab, setTab] = useState<Tab>(() => tabFromPathname(location.pathname));
  const [direction, setDirection] = useState<'next' | 'prev'>('next');

  // Warning shown when "review & checkout" is clicked before every category
  // has been opened. A second click while it's showing bypasses it and
  // proceeds anyway — the donor has now been told twice, once by name.
  const [showWarning, setShowWarning] = useState(false);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);

  // /rewards, /polls, /goals, and /donate all render this same component
  // instance at the same position in the tree, so React won't remount it on
  // navigation between them — sync the active tab to the URL explicitly
  // whenever the pathname changes (e.g. a donor clicks a Navbar link while
  // already on this page).
  useEffect(() => {
    setTab(tabFromPathname(location.pathname));
  }, [location.pathname]);

  // Dismiss a lingering warning banner once the donor moves to a different
  // category — it did its job (or was bypassed) and shouldn't stick around
  // while they browse.
  useEffect(() => {
    setShowWarning(false);
  }, [tab]);

  const selectTab = (next: Tab) => {
    const nextIndex = TABS.indexOf(next);
    const currentIndex = TABS.indexOf(tab);
    setDirection(nextIndex >= currentIndex ? 'next' : 'prev');
    setTab(next);
    track('tab_visit', { tab: next });
  };

  if (loading) return <LoadingSpinner />;

  const slideClass = direction === 'next' ? 'animate-slide-in-right' : 'animate-slide-in-left';
  const tabIndex = TABS.indexOf(tab);
  const unvisited = TABS.filter((t) => !hasVisited(t));
  const allVisited = unvisited.length === 0;

  // Previous/Next always cycle — rewards -> polls -> goals -> rewards -> ...
  // — so donors keep circling through every category rather than hitting a
  // dead end, with "review & checkout" living on its own row as the
  // separate, deliberate exit from the loop.
  const goPrevious = () => {
    setDirection('prev');
    setTab(TABS[(tabIndex - 1 + TABS.length) % TABS.length]!);
  };

  const goNext = () => {
    setDirection('next');
    setTab(TABS[(tabIndex + 1) % TABS.length]!);
  };

  const handleReviewClick = () => {
    if (allVisited || warningAcknowledged) {
      setShowWarning(false);
      openDrawer();
      return;
    }
    setShowWarning(true);
    setWarningAcknowledged(true);
  };

  return (
    <div className="max-w-3xl mx-auto p-8">
      {/* Channel picker — required before browsing incentives. Every donation
          routes to exactly one channel, and incentives tied to a specific
          channel cannot be mixed with another channel's in the same cart, so
          the picker filters what's shown below. */}
      <div className="btrl-panel p-4 mb-6">
        <p className="font-mono text-[10px] tracking-widest uppercase text-d-yellow mb-2">
          channel
        </p>
        {channels.length === 0 ? (
          <p className="font-body text-sm text-off-white/55">No channels are open right now.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  selectChannel(s.id);
                  track('channel_select', { 'channel.id': s.id });
                }}
                className={`font-data font-bold text-sm tracking-wider uppercase px-4 py-2 rounded-sm transition-colors ${
                  selectedChannelId === s.id
                    ? 'text-black'
                    : 'text-off-white/55 hover:text-off-white'
                }`}
                style={{
                  background:
                    selectedChannelId === s.id ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)',
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        {!selectedChannelId && channels.length > 0 && (
          <p className="font-body text-xs text-off-white/55 mt-2">
            Select a channel to see its rewards, polls, and fund goals.
          </p>
        )}
      </div>

      {pendingChannelId && (
        <Modal title="switch channel?" onClose={cancelChannelSwitch}>
          <p className="font-body text-sm text-off-white/55 mb-4">
            Your cart has items tied to your current channel. Incentives can't be mixed across
            channels in one donation — switching will remove those items from your cart (shared
            items stay).
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={cancelChannelSwitch} className="btrl-button btrl-button-outline">
              cancel
            </button>
            <button onClick={confirmChannelSwitch} className="btrl-button">
              switch &amp; clear those items
            </button>
          </div>
        </Modal>
      )}

      {!selectedChannelId ? null : (
        <>
          {/* Tab bar — still clickable for jumping directly to a category. A
          checkmark marks any category the donor has already opened. */}
          <div className="flex justify-center gap-2 mb-8">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => selectTab(t)}
                className={`flex items-center gap-1.5 font-data font-bold text-sm tracking-wider uppercase px-4 py-2 rounded-sm transition-colors ${
                  tab === t ? 'text-black' : 'text-off-white/55 hover:text-off-white'
                }`}
                style={{ background: tab === t ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)' }}
              >
                {t}
                {hasVisited(t) && (
                  <CheckBadgeIcon
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: tab === t ? 'black' : 'var(--green)' }}
                    data-testid={`visited-check-${t}`}
                  />
                )}
              </button>
            ))}
          </div>

          <div className={`transition-all duration-300 ${slideClass}`}>
            {tab === 'rewards' && <RewardList />}
            {tab === 'polls' && <PollList />}
            {tab === 'goals' && <GoalList />}
          </div>

          {/* Previous/Next always available and always cycle through every
          category — there's no "last" step to fall off of. */}
          <div className="flex justify-between items-center mt-8">
            <button onClick={goPrevious} className="btrl-button btrl-button-outline">
              &larr; previous
            </button>
            <button onClick={goNext} className="btrl-button">
              next &rarr;
            </button>
          </div>

          {showWarning && (
            <div
              className="mt-4 p-3 rounded-sm text-sm"
              style={{ background: 'rgba(208,152,70,.16)' }}
            >
              <p className="font-data text-d-yellow mb-1">
                You haven't reviewed {unvisited.map((t) => TAB_LABELS[t]).join(' or ')} yet.
              </p>
              <p className="font-body text-xs text-off-white/55">
                Click "review &amp; checkout" again to skip ahead anyway — your cart is always
                reachable from the cart button too.
              </p>
            </div>
          )}

          {/* Review/checkout lives on its own row, separate from the Previous/
          Next loop, so it reads as a deliberate exit rather than another
          step in the cycle. It's never hard-disabled — clicking it before
          every category has been reviewed shows the warning above instead
          of opening the drawer; a second click bypasses that and proceeds. */}
          <div className="flex justify-center mt-4">
            <button onClick={handleReviewClick} className="btrl-button text-lg py-3 px-8">
              review &amp; checkout
            </button>
          </div>
        </>
      )}
    </div>
  );
}
