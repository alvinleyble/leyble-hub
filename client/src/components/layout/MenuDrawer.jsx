import React, { useEffect, useRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import NavIcon from './NavIcon';
import { MENU_ITEMS, isCurrentPage } from './navigation';

const ROW = `flex w-full items-center gap-3 min-h-[48px] px-5 text-base font-medium transition-colors duration-100
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400`;

/**
 * The hamburger menu: slides in from the right edge, under the button that opens it.
 * Holds what does not earn a tab — Tickets, Audit Log, Settings — and Log out. Stays
 * mounted so it can slide both ways; `invisible` while shut keeps its links out of the
 * tab order and the accessibility tree.
 */
export default function MenuDrawer({ open, onClose, onRefresh }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleLogout = async () => {
    onClose();
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        data-testid="nav-menu"
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-xs flex-col bg-slate-900 text-slate-100
                    transition-[transform,visibility] duration-200 ${
          open ? 'translate-x-0 visible' : 'translate-x-full invisible'
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-700 py-2 pl-5 pr-2">
          <p className="text-lg font-bold tracking-tight">Leyble Hub</p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-12 w-12 items-center justify-center rounded-lg text-slate-300
                       hover:bg-slate-800 hover:text-white
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <NavIcon name="close" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2" aria-label="More">
          {MENU_ITEMS.map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              onClick={(e) => {
                if (onRefresh && isCurrentPage(pathname, path)) {
                  e.preventDefault();
                  onRefresh();
                }
                onClose();
              }}
              data-testid={`nav-link-${path.slice(1)}`}
              className={({ isActive }) =>
                `${ROW} ${isActive ? 'bg-blue-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`
              }
            >
              <NavIcon name={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={handleLogout}
            data-testid="nav-logout"
            className={`${ROW} text-slate-300 hover:bg-slate-800 hover:text-white`}
          >
            <NavIcon name="logout" />
            <span>Log out</span>
          </button>
        </nav>
      </aside>
    </>
  );
}
