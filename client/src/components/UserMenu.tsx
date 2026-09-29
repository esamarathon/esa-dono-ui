import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { UsersIcon, ChevronDownIcon } from './icons';
import { hasAdminAccess, hasModeratorAccess, type DonorWallet } from '../types';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const menuLinkClass =
  'block px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider uppercase text-off-white/80 hover:text-off-white hover:bg-white/5';

export default function UserMenu({
  donor,
  onLogout,
}: {
  donor: DonorWallet;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-off-white/80 hover:text-off-white"
      >
        <UsersIcon className="w-5 h-5 lg:hidden" />
        <span className="hidden lg:flex flex-col text-right leading-tight">
          <span className="font-mono text-[10px] tracking-widest uppercase text-d-yellow">
            logged in as
          </span>
          <span className="font-data font-bold text-sm text-off-white">
            {donor.email} &middot; {fmt(donor.balance_remaining)}
          </span>
        </span>
        <ChevronDownIcon
          className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-56 btrl-panel p-2 z-50"
          style={{ background: 'var(--dark-gray)' }}
        >
          <div
            className="lg:hidden px-3 py-2 mb-1"
            style={{ borderBottom: '1px solid rgba(239,238,236,.08)' }}
          >
            <p className="font-mono text-[10px] tracking-widest uppercase text-d-yellow">
              logged in as
            </p>
            <p className="font-data font-bold text-sm text-off-white truncate">{donor.email}</p>
            <p className="font-data text-sm text-off-white/55">{fmt(donor.balance_remaining)}</p>
          </div>
          <NavLink to="/wallet" onClick={() => setOpen(false)} className={menuLinkClass}>
            wallet
          </NavLink>
          {hasModeratorAccess(donor.role) && (
            <NavLink to="/moderate" onClick={() => setOpen(false)} className={menuLinkClass}>
              moderate
            </NavLink>
          )}
          {hasAdminAccess(donor.role) && (
            <NavLink to="/admin" onClick={() => setOpen(false)} className={menuLinkClass}>
              admin
            </NavLink>
          )}
          <button
            onClick={() => {
              onLogout();
              setOpen(false);
            }}
            className={`${menuLinkClass} w-full text-left`}
          >
            logout
          </button>
        </div>
      )}
    </div>
  );
}
