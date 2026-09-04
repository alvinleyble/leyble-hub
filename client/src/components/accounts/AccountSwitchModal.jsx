import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { listSwitchableAccounts } from '../../offline/accounts';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';

// ADR 0017 #7 — switching between the accounts this tablet remembers.
//
// This is what replaces the profile picker slice 3 deleted, and the difference that
// matters is on the screen: a profile picker listed PEOPLE THE APP KNEW ABOUT, and this
// lists accounts that have successfully signed in on this device. A name only appears
// here because that person typed their own password on this tablet while it had a line
// (ADR 0015 §2), and tapping it switches with no password because that has already been
// proved once.
//
// It works blind, which is the whole point: Josie takes over Alvin's tablet mid-blackout,
// two taps, and the next receipt says Josie — her person number, her device letter, her
// name on the paper (ADR 0017 #10).

export default function AccountSwitchModal({ onClose, onSwitched, onAddAccount }) {
  const { user, switchAccount } = useAuth();
  const { addToast } = useToast();
  const [accounts, setAccounts] = useState(null);
  const [busyEmail, setBusyEmail] = useState(null);

  useEffect(() => {
    let mounted = true;
    listSwitchableAccounts()
      .then((list) => { if (mounted) setAccounts(list); })
      .catch(() => { if (mounted) setAccounts([]); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handlePick = async (account) => {
    if (account.email === user?.email) { onClose(); return; }
    setBusyEmail(account.email);
    try {
      const result = await switchAccount(account.email);
      if (result) {
        // Status in words, not just a changed name in the corner: this is the one thing
        // on the tablet that decides whose number and whose name go on the next receipt.
        addToast(
          result.verified
            ? `Now selling as ${result.full_name || result.email}.`
            : `Now selling as ${result.full_name || result.email}. They will need their password once there is internet.`,
          result.verified ? 'success' : 'error',
        );
        onSwitched?.(result);
      }
      onClose();
    } finally {
      setBusyEmail(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-switch-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md mt-16 bg-white rounded-2xl shadow-xl">
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-slate-200">
          <div>
            <h2 id="account-switch-title" className="text-xl font-bold text-slate-900">
              Who is using this tablet?
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Receipts are numbered and signed with whoever is picked here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center w-12 h-12 -mr-2 -mt-2 rounded-lg shrink-0
                       text-slate-500 hover:bg-slate-100 hover:text-slate-800
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          {accounts === null && (
            <p className="px-2 py-6 text-center text-base text-slate-500">Loading accounts…</p>
          )}

          {accounts?.length === 0 && (
            <p className="px-2 py-6 text-center text-base text-slate-600">
              No other accounts have signed in on this tablet yet. Each person signs in once,
              with internet, and after that they can be picked here without a password.
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {(accounts || []).map((account) => {
              const isCurrent = account.email === user?.email;
              return (
                <li key={account.email}>
                  <button
                    type="button"
                    onClick={() => handlePick(account)}
                    disabled={busyEmail !== null}
                    data-testid={`account-switch-${account.email}`}
                    className={`w-full min-h-[64px] flex items-center gap-3 px-4 py-3 rounded-xl border text-left
                                transition-colors duration-100 disabled:opacity-60
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                                ${isCurrent
                                  ? 'border-blue-600 bg-blue-50'
                                  : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                  >
                    <span
                      aria-hidden="true"
                      className="flex items-center justify-center w-11 h-11 shrink-0 rounded-full
                                 bg-slate-800 text-white text-base font-bold"
                    >
                      {(account.full_name || account.email || '?').trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-semibold text-slate-900 truncate">
                        {account.full_name || account.email}
                      </span>
                      <span className="block text-sm text-slate-500 truncate">{account.email}</span>
                      {/* Status is text as well as colour, never colour alone. */}
                      {!account.has_token && !isCurrent && (
                        <span className="block mt-0.5 text-sm font-semibold text-amber-700">
                          Works offline — will ask for their password once there is internet
                        </span>
                      )}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 text-sm font-bold text-blue-700">Using now</span>
                    )}
                    {busyEmail === account.email && (
                      <span className="shrink-0 text-sm font-semibold text-slate-500">Switching…</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="px-4 pb-5 pt-1 border-t border-slate-200">
          <p className="px-2 py-3 text-sm text-slate-500">
            Someone not on this list signs in with their email and password, once, with
            internet. After that this tablet remembers them.
          </p>
          <Button variant="secondary" className="w-full" onClick={onAddAccount}>
            Sign in as someone else
          </Button>
        </div>
      </div>
    </div>
  );
}
