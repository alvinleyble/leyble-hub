import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useProfile } from '../../context/ProfileContext';
import { V25_OFFLINE_CORE } from '../../config/features';
import { countDuplicateCustomers } from '../../utils/duplicateCustomers';

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/orders',    label: 'Outgoing Orders' },
  { path: '/incoming',  label: 'Incoming Supplies' },
  { path: '/inventory', label: 'Inventory' },
  { path: '/customers', label: 'Customers' },
  { path: '/personnel', label: 'Personnel' },
  { path: '/tickets',   label: 'Tickets' },
  { path: '/audit',     label: 'Audit Log' },
  // ADR 0016 — which tablet holds which of the three receipt-number slots, and the
  // device-replacement action that moves one. Back office, so V1 UI, bottom of the list.
  { path: '/devices',   label: 'Devices' },
];

export default function Sidebar({ onClose, offlineMarker }) {
  const { user, logout } = useAuth();
  const { activeProfile, switchProfile } = useProfile();
  const navigate = useNavigate();
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [dupDismissed, setDupDismissed] = useState(false);

  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    let mounted = true;
    const checkDuplicates = async () => {
      try {
        const data = await api.get('/customers');
        if (mounted && Array.isArray(data)) {
          setDuplicateCount(countDuplicateCustomers(data));
        }
      } catch {}
    };
    checkDuplicates();
    const interval = setInterval(checkDuplicates, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleLogout = async () => {
    if (onClose) onClose();
    await logout();
    navigate('/login', { replace: true });
  };

  const handleSwitchProfile = () => {
    if (onClose) onClose();
    switchProfile();
  };

  return (
    <aside
      className="w-56 h-full flex flex-col shrink-0 bg-slate-900 text-slate-100"
      aria-label="Main navigation"
    >
      {/* Brand header */}
      <div className="flex items-start justify-between px-5 py-5 border-b border-slate-700">
        <div className="min-w-0">
          <p className="text-lg font-bold tracking-tight">Leyble Hub</p>
          <p className="text-xs text-slate-400 mt-0.5 truncate" title={user?.full_name}>
            {activeProfile?.full_name || user?.full_name}
          </p>
          {offlineMarker && <div className="mt-2">{offlineMarker}</div>}
        </div>
        {/* Close button — only rendered in drawer (narrow-screen) mode */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex items-center justify-center w-12 h-12 -mr-3 -mt-2 rounded-lg shrink-0
                       text-slate-300 hover:bg-slate-800 hover:text-white
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {/* Navigation links — each row is at least 48px tall */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV_ITEMS.map(({ path, label }) => {
          const isCustomers = path === '/customers';
          const showDupBadge = V25_OFFLINE_CORE && isCustomers && duplicateCount > 0 && !dupDismissed;
          return (
            <NavLink
              key={path}
              to={path}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center justify-between min-h-[48px] px-5 text-base font-medium transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400
                 ${isActive
                   ? 'bg-blue-700 text-white'
                   : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                 }`
              }
            >
              <span>{label}</span>
              {showDupBadge && (
                <span
                  className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 px-1.5 text-xs font-black tabular-nums gap-1"
                  title={`${duplicateCount} potential duplicate customers`}
                >
                  <span>{duplicateCount}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDupDismissed(true);
                    }}
                    className="hover:text-amber-100 font-bold ml-0.5 text-xs focus:outline-none"
                    aria-label="Dismiss duplicate customer notification badge"
                    title="Dismiss badge"
                  >
                    ✕
                  </button>
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Switch profile / Logout */}
      <div className="p-3 border-t border-slate-700 flex flex-col gap-1">
        <button
          onClick={handleSwitchProfile}
          className="flex items-center justify-center w-full min-h-[48px] px-4 rounded-lg
                     text-slate-300 font-medium
                     hover:bg-slate-800 hover:text-white
                     transition-colors duration-100
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
        >
          Switch profile
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center justify-center w-full min-h-[48px] px-4 rounded-lg
                     text-slate-300 font-medium
                     hover:bg-slate-800 hover:text-white
                     transition-colors duration-100
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
        >
          Log out
        </button>
      </div>
    </aside>
  );
}
