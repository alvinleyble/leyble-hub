import React, { useCallback, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import TopTabBar from './TopTabBar';
import MenuDrawer from './MenuDrawer';
import RefreshIndicator from './RefreshIndicator';
import { useAppRefresh } from './useAppRefresh';
import { usePullToRefresh } from './usePullToRefresh';

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Refresh the way other apps do: pull the page down from its top, or tap the tab
  // (or menu item) of the page that is already open. Both run the same routine.
  const mainRef = useRef(null);
  const { refresh, refreshing } = useAppRefresh();
  const pull = usePullToRefresh(mainRef, { onRefresh: refresh, disabled: refreshing || menuOpen });

  // One layout for every screen size: the tab bar across the top, the page under it.
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <TopTabBar onRefresh={refresh} onOpenMenu={openMenu} menuOpen={menuOpen} />
      <MenuDrawer open={menuOpen} onClose={closeMenu} onRefresh={refresh} />

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
  );
}
