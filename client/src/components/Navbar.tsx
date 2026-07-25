import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { getDonor } from '../api/donor';
import { clearDonorToken } from '../utils/authToken';
import type { DonorWallet } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Navbar() {
  const [donor, setDonor] = useState<DonorWallet | null>(null);
  const location = useLocation();

  useEffect(() => {
    const refresh = () => {
      const token = localStorage.getItem('donor_token');
      if (!token) {
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

  const logout = () => {
    clearDonorToken();
    setDonor(null);
  };

  return (
    <nav
      className="flex items-center gap-6 px-6 py-4 border-b"
      style={{
        background: 'var(--dark-gray)',
        borderColor: 'rgba(239,238,236,.08)',
      }}
    >
      <Link
        to="/"
        className="font-display text-2xl tracking-wide text-off-white no-underline lowercase"
      >
        esa dono
      </Link>
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        home
      </NavLink>
      <NavLink
        to="/wallet"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        wallet
      </NavLink>
      <NavLink
        to="/rewards"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        rewards
      </NavLink>
      <NavLink
        to="/polls"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        polls
      </NavLink>
      <NavLink
        to="/goals"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        goals
      </NavLink>
      <NavLink
        to="/donate"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider lowercase text-black no-underline px-3 py-1 rounded-sm hover:opacity-90 ${isActive ? 'opacity-80' : ''}`
        }
        style={{ background: 'var(--d-yellow)' }}
      >
        donate
      </NavLink>
      <div className="ml-auto flex items-center gap-4">
        {donor && (
          <div className="hidden lg:flex flex-col text-right leading-tight">
            <span className="font-mono text-[10px] tracking-widest uppercase text-d-yellow">
              logged in as
            </span>
            <span className="font-data font-bold text-sm text-off-white">
              {donor.email} &middot; {fmt(donor.balance_remaining)}
            </span>
          </div>
        )}
        {donor?.is_moderator && (
          <NavLink
            to="/moderate"
            className="font-data font-bold text-sm tracking-wider lowercase text-d-yellow hover:text-off-white"
          >
            moderate
          </NavLink>
        )}
        {donor ? (
          <button
            onClick={logout}
            className="font-data font-bold text-sm tracking-wider lowercase text-d-yellow hover:text-off-white"
          >
            logout
          </button>
        ) : (
          <NavLink
            to="/wallet"
            className="font-data font-bold text-sm tracking-wider lowercase text-d-yellow hover:text-off-white"
          >
            login
          </NavLink>
        )}
        <NavLink
          to="/admin"
          className="font-data font-bold text-sm tracking-wider lowercase text-d-yellow hover:text-off-white"
        >
          admin
        </NavLink>
      </div>
    </nav>
  );
}
