import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/orders',    label: 'Outgoing Orders' },
  { path: '/incoming',  label: 'Incoming Supplies' },
  { path: '/inventory', label: 'Inventory' },
  { path: '/customers', label: 'Customers' },
  { path: '/personnel', label: 'Personnel' },
  { path: '/tickets',   label: 'Tickets' },
  { path: '/audit',     label: 'Audit Log' },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <aside
      className="w-56 flex flex-col shrink-0 bg-slate-900 text-slate-100"
      aria-label="Main navigation"
    >
      {/* Brand header */}
      <div className="px-5 py-5 border-b border-slate-700">
        <p className="text-lg font-bold tracking-tight select-none">Leyble Hub</p>
        <p className="text-xs text-slate-400 mt-0.5 truncate" title={user?.full_name}>
          {user?.full_name}
        </p>
      </div>

      {/* Navigation links — each row is at least 48px tall */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV_ITEMS.map(({ path, label }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `flex items-center min-h-[48px] px-5 text-base font-medium transition-colors duration-100
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400
               ${isActive
                 ? 'bg-blue-700 text-white'
                 : 'text-slate-300 hover:bg-slate-800 hover:text-white'
               }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Logout */}
      <div className="p-3 border-t border-slate-700">
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
