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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-switch-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md my-auto bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-slate-200">
          <div className="pr-4">
            <h2 id="account-switch-title" className="text-xl font-bold text-slate-900 tracking-tight">
              Who is using this tablet?
            </h2>
            <p className="mt-1 text-sm text-slate-600 leading-normal">
              Receipts are numbered and signed with whoever is picked here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center w-12 h-12 -mr-2 -mt-2 rounded-xl shrink-0
                       text-slate-400 hover:bg-slate-100 hover:text-slate-700
                       transition-colors duration-150
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {accounts === null && (
            <div className="px-2 py-8 flex flex-col items-center justify-center gap-2">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-500">Loading accounts…</p>
            </div>
          )}

          {accounts?.length === 0 && (
            <div className="px-4 py-8 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-3" aria-hidden="true">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-600 max-w-xs mx-auto leading-relaxed">
                No other accounts have signed in on this tablet yet. Each person signs in once,
                with internet, and after that they can be picked here without a password.
              </p>
            </div>
          )}

          <ul className="flex flex-col gap-3">
            {(accounts || []).map((account) => {
              const isCurrent = account.email === user?.email;
              return (
                <li key={account.email}>
                  <button
                    type="button"
                    onClick={() => handlePick(account)}
                    disabled={busyEmail !== null}
                    data-testid={`account-switch-${account.email}`}
                    className={`w-full min-h-[64px] flex items-start gap-4 p-4 rounded-xl border text-left
                                transition-all duration-150 disabled:opacity-60
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2
                                ${isCurrent
                                  ? 'border-2 border-blue-600 bg-blue-50/80 shadow-sm'
                                  : 'border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 active:bg-slate-100'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex items-center justify-center w-11 h-11 shrink-0 rounded-full text-base font-bold select-none ${
                        isCurrent ? 'bg-blue-700 text-white' : 'bg-slate-800 text-white'
                      }`}
                    >
                      {(account.full_name || account.email || '?').trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-semibold text-slate-900 truncate leading-snug">
                        {account.full_name || account.email}
                      </span>
                      <span className="block text-sm text-slate-500 truncate leading-tight mt-0.5">
                        {account.email}
                      </span>
                      {/* Status is text as well as colour, never colour alone. */}
                      {!account.has_token && !isCurrent && (
                        <span
                          role="status"
                          className="mt-2.5 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-xs font-semibold text-amber-900 leading-snug"
                        >
                          <span className="text-sm shrink-0 leading-none mt-0.5 text-amber-600" aria-hidden="true">⚠️</span>
                          <span>Works offline — will ask for their password once there is internet</span>
                        </span>
                      )}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 mt-0.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-200/80">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600" aria-hidden="true" />
                        Using now
                      </span>
                    )}
                    {busyEmail === account.email && (
                      <span className="shrink-0 mt-0.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                        <svg className="animate-spin h-3.5 w-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                        Switching…
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="px-6 py-5 border-t border-slate-200 bg-slate-50/50">
          <div className="flex items-start gap-2.5 mb-4 text-xs text-slate-500 leading-relaxed">
            <svg
              className="w-4 h-4 shrink-0 mt-0.5 text-slate-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="7" r="4" />
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            </svg>
            <p>
              Someone not on this list signs in with their email and password, once, with
              internet. After that this tablet remembers them.
            </p>
          </div>
          <Button
            variant="secondary"
            className="w-full min-h-[52px] text-base font-semibold justify-center shadow-sm"
            onClick={onAddAccount}
          >
            Sign in as someone else
          </Button>
        </div>
      </div>
    </div>
  );
}
