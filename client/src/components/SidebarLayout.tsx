import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronsLeftIcon, ChevronsRightIcon } from './icons';

export interface SidebarNavItem {
  to: string;
  label: string;
  end?: boolean;
  icon: (props: { className?: string }) => ReactNode;
}

/** A labelled section of staff navigation (#238): heading above its items. */
export interface SidebarNavGroup {
  heading: string;
  items: SidebarNavItem[];
}

interface SidebarLayoutProps {
  title: string;
  /** Grouped navigation; headings hide when the sidebar is collapsed. */
  groups: SidebarNavGroup[];
  storageKey: string;
  footer?: (collapsed: boolean) => ReactNode;
  /** Right side of the location bar above the content (e.g. the moderator
   *  channel filter, which applies to the page currently shown). */
  header?: ReactNode;
}

export default function SidebarLayout({
  title,
  groups,
  storageKey,
  footer,
  header,
}: SidebarLayoutProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) !== '0');
  const { pathname } = useLocation();

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(storageKey, next ? '1' : '0');
      return next;
    });
  };

  // Location-bar label (#238): the active nav item, falling back to its
  // section (e.g. a donation detail page shows its list's label).
  const activeItem = groups
    .flatMap((g) => g.items)
    .find((n) =>
      n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`),
    );

  return (
    // App-shell layout (#64): the outer container is pinned to exactly one
    // viewport height and never scrolls itself. The sidebar and the main
    // content area are each their own independent scroll container
    // (overflow-y-auto), so a long nav list or a long page of content can
    // each scroll on their own without moving the other — previously this
    // was `min-h-screen` with a `sticky` sidebar, which meant the whole
    // *document* scrolled as one long page and any page-level two-column
    // layout (e.g. AdminDonors' donor list + detail panel) shared that same
    // single scroll, growing the page instead of scrolling internally.
    <div className="flex h-screen overflow-hidden">
      <aside
        className={`flex flex-col p-4 overflow-y-auto transition-[width] duration-150 ${collapsed ? 'w-16' : 'w-52'}`}
        style={{ background: 'var(--dark-gray)', borderRight: '1px solid rgba(239,238,236,.08)' }}
      >
        <div
          className={`font-display text-2xl mb-6 uppercase text-d-yellow ${collapsed ? 'text-center text-base' : ''}`}
        >
          {collapsed ? title.slice(0, 1) : title}
        </div>
        {groups.map((group) => (
          <div key={group.heading}>
            {!collapsed && (
              <div className="font-mono mt-4 mb-1 px-3 text-[10px] uppercase tracking-widest text-off-white/40">
                {group.heading}
              </div>
            )}
            <nav className="space-y-1">
              {group.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  title={collapsed ? n.label : undefined}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider uppercase ${collapsed ? 'justify-center' : ''} ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
                  }
                  style={({ isActive }) => (isActive ? { background: 'var(--grad)' } : {})}
                >
                  <n.icon className="w-4 h-4 shrink-0" />
                  {!collapsed && <span>{n.label}</span>}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
        <button
          onClick={toggle}
          title={collapsed ? 'expand' : 'collapse'}
          className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${collapsed ? 'justify-center' : ''}`}
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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Location bar (#238): where the user is, plus page-scoped controls
            on the right, always visible above the scrolling content. */}
        <div
          className="flex h-10 shrink-0 items-center justify-between px-6"
          style={{
            background: 'var(--dark-gray)',
            borderBottom: '1px solid rgba(239,238,236,.08)',
          }}
        >
          <span className="font-mono text-xs uppercase tracking-widest text-off-white/50">
            {activeItem?.label}
          </span>
          {header && <div className="flex items-center gap-3">{header}</div>}
        </div>
        <main className="flex-1 overflow-y-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
