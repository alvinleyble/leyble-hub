import React, { useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import OfflineMarker from './OfflineMarker';
import RefreshIndicator from './RefreshIndicator';
import { useAppRefresh } from './useAppRefresh';
import { usePullToRefresh } from './usePullToRefresh';

export default function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  // Refresh the way other apps do: pull the page down from its top, or tap the menu
  // item of the page that is already open (every device). Both run the same routine.
  const mainRef = useRef(null);
  const { refresh, refreshing } = useAppRefresh();
  const pull = usePullToRefresh(mainRef, { onRefresh: refresh, disabled: refreshing || navOpen });

  // `desktop:` = min-width 1024px AND a fine pointer (mouse/trackpad) — see
  // tailwind.config.js. Phones/tablets get the slide-in drawer in both
  // portrait and landscape; only real desktops get the permanent sidebar.
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Static sidebar — desktops only. V1 has no desktop top bar, so the
          always-visible offline marker (G9) lives in the sidebar's brand
          header here instead. */}
      <div className="hidden desktop:flex">
        <Sidebar offlineMarker={<OfflineMarker variant="v1" />} onRefresh={refresh} />
      </div>

      {/* Slide-in drawer — phones/tablets, any orientation */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 desktop:hidden transition-opacity duration-200 ${
          navOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={closeNav}
        aria-hidden="true"
      />
      <div
        className={`fixed inset-y-0 left-0 z-50 desktop:hidden transition-transform duration-200 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar onClose={closeNav} onRefresh={refresh} />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar with menu button — phones/tablets only */}
        <header className="desktop:hidden flex items-center gap-1 shrink-0 h-14 px-2 bg-slate-900 text-slate-100">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            data-testid="nav-menu-button"
            className="flex items-center justify-center w-12 h-12 rounded-lg
                       hover:bg-slate-800
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <p className="text-lg font-bold tracking-tight select-none">Leyble Hub</p>
          <div className="ml-auto flex items-center gap-2">
            <OfflineMarker variant="v1" />
          </div>
        </header>

        {/* `overscroll-y-contain` keeps the WebView's own overscroll glow / pull effect
            out of the way of ours. */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <RefreshIndicator pull={pull} refreshing={refreshing} />
          <main
            ref={mainRef}
            className="flex-1 overflow-y-auto overscroll-y-contain focus:outline-none"
            tabIndex={-1}
            id="main-content"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
