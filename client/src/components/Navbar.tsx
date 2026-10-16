import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { getDonor } from '../api/donor';
import { getFeatureFlags } from '../api/featureFlags';
import { isSessionActive, endSession } from '../utils/authToken';
import { useDraftPledge } from '../context/DraftPledgeContext';
import UserMenu from './UserMenu';
import type { DonorWallet } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Navbar() {
  const [donor, setDonor] = useState<DonorWallet | null>(null);
  const [auctionsEnabled, setAuctionsEnabled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { draft } = useDraftPledge();
  const resume = draft && !location.pathname.startsWith('/donate');
  const donatePath = draft
    ? `${draft.path}?${new URLSearchParams({
        step: draft.lastStep,
        tab: draft.tab,
        ...(draft.channelId ? { channel: draft.channelId } : {}),
      })}`
    : '/donate';

  useEffect(() => {
    getFeatureFlags()
      .then((flags) => setAuctionsEnabled(flags.auctions ?? false))
      .catch(() => setAuctionsEnabled(false));
  }, []);

  useEffect(() => {
    const refresh = () => {
      if (!isSessionActive()) {
        setDonor(null);
        return;
      }
      getDonor()
        .then(setDonor)
        .catch(() => setDonor(null));
    };
    refresh();
    window.addEventListener('donor-token-changed', refresh);
    return () => window.removeEventListener('donor-token-changed', refresh);
  }, [location.pathname, location.search]);

  const logout = async () => {
    await endSession();
    setDonor(null);
    navigate('/');
  };

  return (
    <nav
      className="flex items-center gap-6 px-6 py-4 border-b"
      style={{
        background: 'var(--dark-gray)',
        borderColor: 'rgba(239,238,236,.08)',
      }}
    >
      <Link to="/" className="shrink-0" aria-label="ESA home">
        <img src="/brand/emblem-dark.svg" alt="ESA" width={40} height={40} />
      </Link>
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider uppercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        home
      </NavLink>
      <NavLink
        to="/help"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider uppercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        help
      </NavLink>
      {auctionsEnabled && (
        <NavLink
          to="/auctions"
          className={({ isActive }) =>
            `font-data font-bold text-sm tracking-wider uppercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
          }
        >
          auctions
        </NavLink>
      )}
      <NavLink
        to={donatePath}
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider uppercase text-black no-underline px-3 py-1 rounded-sm hover:opacity-90 ${isActive ? 'opacity-80' : ''}`
        }
        style={{ background: 'var(--d-yellow)' }}
      >
        {resume ? `resume ${fmt(draft.amountCents)} donation` : 'donate'}
      </NavLink>
      <div className="ml-auto flex items-center gap-4">
        {donor ? (
          <UserMenu donor={donor} onLogout={logout} />
        ) : (
          <NavLink
            to="/wallet"
            className="font-data font-bold text-sm tracking-wider uppercase text-d-yellow hover:text-off-white"
          >
            login
          </NavLink>
        )}
      </div>
    </nav>
  );
}
