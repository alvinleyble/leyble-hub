import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useProfile } from '../../context/ProfileContext';
import BackOfficeDrawer from './BackOfficeDrawer';

// V2 exposes exactly three top-level destinations. Everything else lives
// behind the Back Office drawer.
const NAV_ITEMS = [
  { path: '/v2/pos',       label: 'POS' },
  { path: '/v2/inventory', label: 'Inventory' },
  { path: '/v2/customers', label: 'Customers' },
];

// Persistent V2 tablet shell — landscape-first (Honor Pad X8B, ~1200x1920).
// Dark slate chrome, 52px+ touch targets, 16-18px+ text.
export default function V2Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { user, logout } = useAuth();
  const { activeProfile, switchProfile } = useProfile();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="v2-root flex h-screen flex-col overflow-hidden bg-v2-bg text-v2-text">
      <header className="shrink-0 flex items-center gap-3 h-[68px] px-3 bg-v2-surface border-b border-v2-border">
        <p className="px-2 text-xl font-bold tracking-tight select-none shrink-0">Leyble Hub</p>

        <nav className="flex items-center gap-2 min-w-0" aria-label="Main navigation">
          {NAV_ITEMS.map(({ path, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `flex items-center justify-center min-h-tablet px-6 rounded-xl text-lg font-semibold
                 transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                 ${isActive
                   ? 'bg-v2-accent-strong text-white'
                   : 'text-v2-muted hover:bg-v2-raised hover:text-v2-text'}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="hidden sm:block px-2 text-base text-v2-muted truncate max-w-[12rem]">
            {activeProfile?.full_name || user?.full_name}
          </span>
          <button
            type="button"
            onClick={switchProfile}
            className="flex items-center justify-center min-h-tablet px-5 rounded-xl text-base font-semibold
                       text-v2-muted hover:bg-v2-raised hover:text-v2-text transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Switch profile
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center justify-center min-h-tablet px-5 rounded-xl text-base font-semibold
                       text-v2-muted hover:bg-v2-raised hover:text-v2-text transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Log out
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            className="flex items-center gap-2 min-h-tablet px-5 rounded-xl text-lg font-semibold
                       bg-v2-raised text-v2-text hover:bg-v2-border transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Back Office
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto focus:outline-none" tabIndex={-1} id="v2-main-content">
        <Outlet />
      </main>

      <BackOfficeDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
