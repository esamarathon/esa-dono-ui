import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/admin', label: 'dashboard', end: true },
  { to: '/admin/donors', label: 'donors' },
  { to: '/admin/rewards', label: 'rewards' },
  { to: '/admin/polls', label: 'polls' },
  { to: '/admin/goals', label: 'goals' },
  { to: '/admin/donations', label: 'donations & claims' },
  { to: '/admin/pledges', label: 'pledges' },
  { to: '/admin/blocked-words', label: 'blocked words' },
  { to: '/admin/simulate', label: 'simulate' },
];

export default function AdminLayout() {
  const [key, setKey] = useState(localStorage.getItem('admin_key') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const isLoggedIn = !!key;

  const login = () => {
    if (!input.trim()) {
      setError('Enter API key');
      return;
    }
    localStorage.setItem('admin_key', input.trim());
    setKey(input.trim());
    setError('');
  };

  const logout = () => {
    localStorage.removeItem('admin_key');
    setKey('');
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="btrl-panel p-8 w-full max-w-sm">
          <h1 className="font-display text-3xl lowercase mb-4">admin login</h1>
          <input
            type="password"
            placeholder="Enter admin API key"
            className="w-full px-3 py-2 mb-3 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
          />
          {error && (
            <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
          <button onClick={login} className="btrl-button w-full">
            login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside
        className="w-52 flex flex-col p-4"
        style={{ background: 'var(--dark-gray)', borderRight: '1px solid rgba(239,238,236,.08)' }}
      >
        <div className="font-display text-2xl mb-6 lowercase text-d-yellow">admin</div>
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
        <button
          onClick={logout}
          className="font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white mt-4 text-left"
        >
          logout
        </button>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
