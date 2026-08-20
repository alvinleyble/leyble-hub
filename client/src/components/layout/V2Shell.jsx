import React, { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useProfile } from '../../context/ProfileContext';
import { usePrinter } from '../../context/PrinterContext';
import BackOfficeDrawer from './BackOfficeDrawer';

// V2 exposes exactly three top-level destinations. Everything else lives
// behind the Back Office drawer.
const NAV_ITEMS = [
  { path: '/v2/pos',       label: 'POS' },
  { path: '/v2/inventory', label: 'Inventory' },
  { path: '/v2/customers', label: 'Customers' },
];

const THEME_VARS = {
  dark: {
    '--v2-bg': '#121214',
    '--v2-surface': '#1B1B1E',
    '--v2-raised': '#262629',
    '--v2-border': '#333338',
    '--v2-text': '#F4F4F5',
    '--v2-muted': '#A1A1AA',
    '--v2-accent': '#F43F5E',
    '--v2-accent-strong': '#9F1239',
    '--v2-pill-active': '#27272A',
    '--v2-pill-border': '#3F3F46',
    '--v2-pill-text': '#FFFFFF',
    '--v2-print-btn': '#4F46E5',
    '--v2-print-btn-hover': '#6366F1',
    '--v2-suki-badge-bg': 'rgba(139, 92, 246, 0.15)',
    '--v2-suki-badge-border': 'rgba(139, 92, 246, 0.35)',
    '--v2-suki-badge-text': '#C4B5FD',
    '--v2-table-hover': '#262629',
  },
  light: {
    '--v2-bg': '#F4F5F7',
    '--v2-surface': '#FFFFFF',
    '--v2-raised': '#E9EBEF',
    '--v2-border': '#D7DAE0',
    '--v2-text': '#1B1E27',
    '--v2-muted': '#5B6270',
    '--v2-accent': '#0D9488',
    '--v2-accent-strong': '#0F766E',
    '--v2-pill-active': '#0F766E',
    '--v2-pill-border': '#0D9488',
    '--v2-pill-text': '#FFFFFF',
    '--v2-print-btn': '#0369A1',
    '--v2-print-btn-hover': '#0284C7',
    '--v2-suki-badge-bg': '#EDE9FE',
    '--v2-suki-badge-border': '#DDD6FE',
    '--v2-suki-badge-text': '#6D28D9',
    '--v2-table-hover': '#F1F3F6',
  },
};

// Persistent V2 tablet shell — landscape-first (Honor Pad X8B, ~1200x1920).
// Dark slate chrome, 52px+ touch targets, 16-18px+ text.
export default function V2Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('v2_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });
  const [tapCount, setTapCount] = useState(0);
  const lastTapRef = useRef(0);
  const { user, logout } = useAuth();
  const { activeProfile, switchProfile } = useProfile();
  const { openPicker: openPrinterPicker } = usePrinter();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    } catch {}
  }, [theme]);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    try {
      localStorage.setItem('v2_theme', nextTheme);
    } catch {}
  };

  // 5 taps/clicks on "Leyble Hub" or the top-right profile area opens the Back Office drawer
  const handleSecretTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current > 2500) {
      lastTapRef.current = now;
      setTapCount(1);
      return;
    }
    lastTapRef.current = now;
    const nextCount = tapCount + 1;
    if (nextCount >= 5) {
      setTapCount(0);
      setDrawerOpen(true);
    } else {
      setTapCount(nextCount);
    }
  };

  return (
    <div
      data-theme={theme}
      style={THEME_VARS[theme] || THEME_VARS.dark}
      className={`v2-root flex h-screen flex-col overflow-hidden bg-v2-bg text-v2-text ${theme}`}
    >
      <header className="shrink-0 flex items-center gap-3 h-[68px] px-3 bg-v2-surface border-b border-v2-border">
        <button
          type="button"
          onClick={handleSecretTap}
          className="px-2 text-xl font-bold tracking-tight select-none shrink-0 flex items-center gap-2.5 bg-transparent border-0 text-left focus:outline-none cursor-default"
          aria-label="Leyble Hub"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.6)]" aria-hidden="true" />
          Leyble Hub
        </button>

        <nav className="flex items-center gap-2 min-w-0" aria-label="Main navigation">
          {NAV_ITEMS.map(({ path, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `flex items-center justify-center gap-2 min-h-tablet px-6 rounded-xl text-lg font-semibold
                 transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                 ${isActive
                   ? 'bg-v2-pill-active text-v2-pill-text border border-v2-pill-border shadow-sm'
                   : 'text-v2-muted hover:bg-v2-raised hover:text-v2-text'}`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" aria-hidden="true" />}
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={openPrinterPicker}
            className="flex items-center justify-center min-h-tablet px-3.5 rounded-xl text-base font-semibold
                       text-v2-muted hover:bg-v2-raised hover:text-v2-text transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
            aria-label="Configure printer"
            title="Configure printer"
          >
            🖨️ Printer
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center justify-center min-h-tablet px-3.5 rounded-xl text-base font-semibold
                       text-v2-muted hover:bg-v2-raised hover:text-v2-text transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
            aria-label={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
          >
            {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
          <button
            type="button"
            onClick={handleSecretTap}
            className="hidden sm:block px-2 text-base text-v2-muted truncate max-w-[12rem] bg-transparent border-0 text-left focus:outline-none cursor-default select-none"
            title="Profile"
          >
            {activeProfile?.full_name || user?.full_name}
          </button>
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
        </div>
      </header>

      <main className="flex-1 overflow-y-auto focus:outline-none" tabIndex={-1} id="v2-main-content">
        <Outlet />
      </main>

      <BackOfficeDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
