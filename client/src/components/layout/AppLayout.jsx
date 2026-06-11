import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  // `desktop:` = min-width 1024px AND a fine pointer (mouse/trackpad) — see
  // tailwind.config.js. Phones/tablets get the slide-in drawer in both
  // portrait and landscape; only real desktops get the permanent sidebar.
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Static sidebar — desktops only */}
      <div className="hidden desktop:flex">
        <Sidebar />
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
        <Sidebar onClose={closeNav} />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar with menu button — phones/tablets only */}
        <header className="desktop:hidden flex items-center gap-1 shrink-0 h-14 px-2 bg-slate-900 text-slate-100">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="flex items-center justify-center w-12 h-12 rounded-lg
                       hover:bg-slate-800
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <p className="text-lg font-bold tracking-tight select-none">Leyble Hub</p>
        </header>

        <main className="flex-1 overflow-y-auto focus:outline-none" tabIndex={-1} id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
