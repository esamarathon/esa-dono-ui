import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/moderate', label: 'dashboard', end: true },
  { to: '/moderate/polls', label: 'polls' },
  { to: '/moderate/rewards', label: 'rewards' },
  { to: '/moderate/goals', label: 'goals' },
  { to: '/moderate/claims', label: 'claims' },
];

export default function ModeratorLayout() {
  return (
    <div className="min-h-screen flex">
      <aside
        className="w-52 flex flex-col p-4"
        style={{ background: 'var(--dark-gray)', borderRight: '1px solid rgba(239,238,236,.08)' }}
      >
        <div className="font-display text-2xl mb-6 lowercase text-d-yellow">moderator</div>
        <nav className="flex-1 space-y-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider lowercase ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
              }
              style={({ isActive }) => (isActive ? { background: 'var(--grad)' } : {})}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
