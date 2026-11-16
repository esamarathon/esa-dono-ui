// Shared staff sidebar footer (#238): "back to home" and the logout button
// rendered by both staff layouts. logoutLabel '' hides the logout button
// (moderator donor-session access has no key to clear).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { HomeIcon, LogoutIcon } from './icons';

interface StaffSidebarFooterProps {
  collapsed: boolean;
  logout: () => void;
  logoutLabel: string;
}

/** One shared footer body; the collapse-aware wrapper stays in each layout. */
export function StaffSidebarFooterBody({
  collapsed,
  logout,
  logoutLabel,
}: StaffSidebarFooterProps): ReactNode {
  const align = collapsed ? 'justify-center' : 'text-left';
  return (
    <div className="flex flex-col">
      <Link
        to="/"
        title="back to home"
        className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${align}`}
      >
        <HomeIcon className="w-4 h-4 shrink-0" />
        {!collapsed && <span>back to home</span>}
      </Link>
      {logoutLabel ? (
        <button
          onClick={logout}
          title="logout"
          className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white ${align}`}
        >
          <LogoutIcon className="w-4 h-4 shrink-0" />
          {!collapsed && <span>{logoutLabel}</span>}
        </button>
      ) : null}
    </div>
  );
}
