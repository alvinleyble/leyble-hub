import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { V25_OFFLINE_CORE } from '../../config/features';
import NavIcon from './NavIcon';
import StatusLight from './StatusLight';
import { TAB_ITEMS, isCurrentPage } from './navigation';
import { useDuplicateBubble } from './useDuplicateBubble';

/**
 * The row of tabs across the top of every screen, on every screen size. Phones show
 * icons only (the name stays as visually hidden text, so each tab is still named for
 * a screen reader); tablets and computers add the name under or beside the icon.
 * The status light and the menu button sit at the far right.
 *
 * Tapping the tab of the page that is already open refreshes it instead of
 * re-navigating to it, like re-tapping Home in any social app.
 */
export default function TopTabBar({ onRefresh, onOpenMenu, menuOpen = false, duplicatesEnabled = V25_OFFLINE_CORE }) {
  const { pathname } = useLocation();
  const duplicateCount = useDuplicateBubble({
    enabled: duplicatesEnabled,
    onCustomers: pathname === '/customers' || pathname.startsWith('/customers/'),
  });

  return (
    <header className="flex shrink-0 items-stretch h-14 sm:h-16 lg:h-14 bg-slate-900 text-slate-100">
      <nav className="flex flex-1 min-w-0" aria-label="Main navigation">
        {TAB_ITEMS.map(({ path, label, icon }) => {
          const bubble = path === '/customers' ? duplicateCount : 0;
          return (
            <NavLink
              key={path}
              to={path}
              onClick={(e) => {
                if (onRefresh && isCurrentPage(pathname, path)) {
                  e.preventDefault();
                  onRefresh();
                }
              }}
              data-testid={`nav-link-${path.slice(1)}`}
              title={label}
              className={({ isActive }) =>
                `group relative flex flex-1 min-w-0 lg:max-w-[11rem] flex-col lg:flex-row items-center justify-center
                 gap-0.5 lg:gap-2 px-1 transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400
                 ${isActive ? 'text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <NavIcon name={icon} className={`w-6 h-6 ${isActive ? 'text-blue-400' : ''}`} />
                    {bubble > 0 && (
                      <span
                        className="absolute -top-1.5 -right-2.5 flex h-5 min-w-[1.25rem] items-center justify-center
                                   rounded-full bg-red-600 px-1 text-xs font-bold leading-none text-white tabular-nums
                                   ring-2 ring-slate-900"
                        aria-hidden="true"
                        data-testid="customers-duplicate-bubble"
                      >
                        {bubble > 99 ? '99+' : bubble}
                      </span>
                    )}
                  </span>
                  <span className="sr-only sm:not-sr-only sm:truncate sm:max-w-full text-base font-medium leading-tight">
                    {label}
                  </span>
                  {bubble > 0 && (
                    <span className="sr-only"> ({bubble} possible duplicate{bubble === 1 ? "" : "s"})</span>
                  )}
                  {/* Active marker: a bar under the tab, on top of the brighter colour
                      and aria-current, so the page on screen is never told by colour alone. */}
                  <span
                    className={`absolute inset-x-2 bottom-0 h-1 rounded-t bg-blue-400 ${isActive ? '' : 'invisible'}`}
                    aria-hidden="true"
                  />
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center pr-1 sm:pr-2">
        <StatusLight />
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-haspopup="dialog"
          data-testid="nav-menu-button"
          className="flex h-12 w-12 items-center justify-center rounded-lg hover:bg-slate-800
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <NavIcon name="menu" />
        </button>
      </div>
    </header>
  );
}
