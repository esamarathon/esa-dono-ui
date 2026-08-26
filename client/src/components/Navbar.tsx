import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { getDonor } from '../api/donor';
import { isSessionActive, endSession } from '../utils/authToken';
import { useCart } from '../context/CartContext';
import UserMenu from './UserMenu';
import type { DonorWallet } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function Navbar() {
  const [donor, setDonor] = useState<DonorWallet | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { cart, totalCents, toggleDrawer } = useCart();

  // Brief "juice" pop on the cart badge whenever the cart total actually
  // changes, so adding/removing an item is felt, not just reflected. Skips
  // the very first render (a cart restored from sessionStorage shouldn't
  // pop on page load, only on subsequent changes).
  const [pop, setPop] = useState(false);
  const prevSignature = useRef<string | null>(null);
  useEffect(() => {
    const signature = `${cart.length}:${totalCents}`;
    if (prevSignature.current === null) {
      prevSignature.current = signature;
      return;
    }
    if (prevSignature.current === signature) return;
    prevSignature.current = signature;
    setPop(true);
    const timer = setTimeout(() => setPop(false), 400);
    return () => clearTimeout(timer);
  }, [cart.length, totalCents]);

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
      <Link
        to="/"
        className="font-display text-2xl tracking-wide text-off-white no-underline uppercase"
      >
        esa dono
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
      <NavLink
        to="/auctions"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider uppercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
        }
      >
        auctions
      </NavLink>
      <NavLink
        to="/donate"
        className={({ isActive }) =>
          `font-data font-bold text-sm tracking-wider uppercase text-black no-underline px-3 py-1 rounded-sm hover:opacity-90 ${isActive ? 'opacity-80' : ''}`
        }
        style={{ background: 'var(--d-yellow)' }}
      >
        contribute
      </NavLink>
      <div className="ml-auto flex items-center gap-4">
        <button
          onClick={toggleDrawer}
          className="relative font-data font-bold text-sm tracking-wider uppercase text-off-white/80 hover:text-off-white flex items-center gap-2"
        >
          <span>cart</span>
          {cart.length > 0 && (
            <span
              className={`font-data text-xs font-bold px-2 py-0.5 rounded-sm ${pop ? 'animate-cart-pop' : ''}`}
              style={{ background: 'var(--d-yellow)', color: 'black' }}
            >
              {cart.length} &middot; {fmt(totalCents)}
            </span>
          )}
        </button>
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
