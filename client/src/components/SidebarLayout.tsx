import { useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ChevronsLeftIcon, ChevronsRightIcon } from './icons';

export interface SidebarNavItem {
  to: string;
  label: string;
  end?: boolean;
  icon: (props: { className?: string }) => ReactNode;
}

interface SidebarLayoutProps {
  title: string;
  nav: SidebarNavItem[];
  storageKey: string;
  footer?: (collapsed: boolean) => ReactNode;
}

export default function SidebarLayout({ title, nav, storageKey, footer }: SidebarLayoutProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) === '1');

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(storageKey, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div className="min-h-screen flex">
      <aside
        className={`flex flex-col p-4 transition-[width] duration-150 ${collapsed ? 'w-16' : 'w-52'}`}
        style={{ background: 'var(--dark-gray)', borderRight: '1px solid rgba(239,238,236,.08)' }}
      >
        <div
          className={`font-display text-2xl mb-6 lowercase text-d-yellow ${collapsed ? 'text-center text-base' : ''}`}
        >
          {collapsed ? title.slice(0, 1) : title}
        </div>
        <nav className="flex-1 space-y-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              title={collapsed ? n.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider lowercase ${collapsed ? 'justify-center' : ''} ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
              }
              style={({ isActive }) => (isActive ? { background: 'var(--grad)' } : {})}
            >
              <n.icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span>{n.label}</span>}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={toggle}
          title={collapsed ? 'expand' : 'collapse'}
          className={`flex items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${collapsed ? 'justify-center' : ''}`}
        >
          {collapsed ? (
            <ChevronsRightIcon className="w-4 h-4" />
          ) : (
            <>
              <ChevronsLeftIcon className="w-4 h-4" />
              <span>collapse</span>
            </>
          )}
        </button>
        {footer?.(collapsed)}
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
