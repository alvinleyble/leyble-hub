import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Button from '../components/ui/Button';
import AccountSwitchModal from '../components/accounts/AccountSwitchModal';

// Settings, reached from the hamburger menu. For now it holds who is signed in and the
// ADR 0017 #7 account switch that used to hang off the name under the sidebar's brand;
// the rest of what belongs here is a later item.
export default function SettingsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Deliberately NOT a logout. Signing in as a fourth person must not cost whoever is
  // holding the tablet the passwordless switch back to their own account — the login
  // screen adds the new account and makes it active on its own.
  const handleAddAccount = () => {
    setSwitcherOpen(false);
    navigate('/login');
  };

  const name = user?.full_name || user?.email || '';

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>

      <section
        aria-labelledby="settings-profile-heading"
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 id="settings-profile-heading" className="text-lg font-semibold text-slate-900 mb-4">
          Profile
        </h2>
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-blue-700 text-xl font-bold text-white select-none"
          >
            {name.trim().charAt(0).toUpperCase() || '?'}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-500">Signed in as</p>
            <p className="truncate text-lg font-semibold text-slate-900" data-testid="settings-profile-name">{name}</p>
            {user?.email && user.email !== name && (
              <p className="truncate text-base text-slate-600">{user.email}</p>
            )}
          </div>
        </div>
        <p className="mt-4 text-base text-slate-600">
          Receipts are numbered and signed with whoever is signed in here.
        </p>
        <Button
          variant="secondary"
          className="mt-4 w-full sm:w-auto"
          onClick={() => setSwitcherOpen(true)}
          data-testid="account-switcher-button"
        >
          Switch account
        </Button>
      </section>

      {switcherOpen && (
        <AccountSwitchModal
          onClose={() => setSwitcherOpen(false)}
          onAddAccount={handleAddAccount}
        />
      )}
    </div>
  );
}
