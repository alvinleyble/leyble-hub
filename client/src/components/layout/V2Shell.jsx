import React, { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useProfile } from '../../context/ProfileContext';
import { usePrinter } from '../../context/PrinterContext';
import { useToast } from '../ui/Toast';

const PREFERRED_KEY = 'preferred_ui';
const LONG_PRESS_MS = 3000;

// V2 exposes exactly three top-level destinations.
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
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('v2_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });
  const longPressTimerRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const holdStartRef = useRef(null);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const { user, logout } = useAuth();
  const { activeProfile, switchProfile } = useProfile();
  const { openPicker: openPrinterPicker } = usePrinter();
  const { addToast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, []);

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

  // 3-second long-press on "Leyble Hub" navigates to V1 Admin Portal with feedback + toast
  const startLongPress = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clearTimeout(longPressTimerRef.current);
    clearInterval(progressIntervalRef.current);
    setHolding(true);
    setProgress(0);
    holdStartRef.current = Date.now();
    progressIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - holdStartRef.current;
      setProgress(Math.min(100, (elapsed / LONG_PRESS_MS) * 100));
    }, 32);
    longPressTimerRef.current = setTimeout(() => {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
      setHolding(false);
      setProgress(0);
      try { localStorage.setItem(PREFERRED_KEY, 'v1'); } catch {}
      addToast('Switched to V1 Admin Portal', 'success');
      navigate('/orders');
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setHolding(false);
    setProgress(0);
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
          onPointerDown={startLongPress}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative overflow-hidden px-2 text-xl font-bold tracking-tight select-none shrink-0 flex items-center gap-2.5 bg-transparent border-0 text-left focus:outline-none cursor-default rounded-lg transition-opacity duration-150 ${holding ? 'opacity-90 ring-1 ring-v2-accent/30' : 'opacity-100'}`}
          style={{
            background: holding ? `linear-gradient(to right, rgba(244,63,94,0.18) ${progress}%, transparent ${progress}%)` : undefined,
            touchAction: 'none',
          }}
          aria-label="Leyble Hub — hold 3 seconds to switch to V1 Admin Portal"
        >
          <span className={`h-2.5 w-2.5 rounded-full bg-red-600 shrink-0 ${holding ? 'animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.85)]' : 'shadow-[0_0_8px_rgba(220,38,38,0.6)]'}`} aria-hidden="true" />
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
          <span
            className="hidden sm:block px-2 text-base text-v2-muted truncate max-w-[12rem] select-none"
            title="Profile"
          >
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
        </div>
      </header>

      <main className="flex-1 overflow-y-auto focus:outline-none" tabIndex={-1} id="v2-main-content">
        <Outlet />
      </main>
    </div>
  );
}
