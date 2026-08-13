import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { getDonor } from '../../api/donor';
import { hasModeratorAccess } from '../../types';

const NAV = [
  { to: '/moderate', label: 'dashboard', end: true },
  { to: '/moderate/polls', label: 'polls' },
  { to: '/moderate/rewards', label: 'rewards' },
  { to: '/moderate/goals', label: 'goals' },
  { to: '/moderate/claims', label: 'claims' },
];

type AccessState = 'checking' | 'granted' | 'denied';

export default function ModeratorLayout() {
  const [access, setAccess] = useState<AccessState>('checking');
  const [key, setKey] = useState(localStorage.getItem('moderator_key') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // A stored moderator key is treated as a valid fallback (mirrors admin
    // key behavior) — actual API calls will 401/403 if it's wrong.
    if (key) {
      setAccess('granted');
      return;
    }
    const donorToken = localStorage.getItem('donor_token');
    if (!donorToken) {
      setAccess('denied');
      return;
    }
    getDonor()
      .then((donor) => setAccess(hasModeratorAccess(donor.role) ? 'granted' : 'denied'))
      .catch(() => setAccess('denied'));
  }, [key]);

  const login = () => {
    if (!input.trim()) {
      setError('Enter moderator key');
      return;
    }
    localStorage.setItem('moderator_key', input.trim());
    setKey(input.trim());
    setError('');
  };

  const logout = () => {
    localStorage.removeItem('moderator_key');
    setKey('');
    setAccess('checking');
  };

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="btrl-panel p-8 w-full max-w-sm">
          <h1 className="font-display text-3xl lowercase mb-2">moderator login</h1>
          <p className="font-data text-sm text-off-white/55 mb-4">
            Log in with your donor magic link for moderator/admin access, or enter a moderator key
            below.
          </p>
          <input
            type="password"
            placeholder="Enter moderator key"
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
        {key && (
          <button
            onClick={logout}
            className="font-mono text-[10px] tracking-wider uppercase text-off-white/55 hover:text-off-white mt-4 text-left"
          >
            logout (moderator key)
          </button>
        )}
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
