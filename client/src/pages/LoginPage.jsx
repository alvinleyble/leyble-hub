import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, getLastKnownIdentity } from '../context/AuthContext';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import FormField from '../components/ui/FormField';
import { V25_OFFLINE_CORE } from '../config/features';
import { waitingCount } from '../offline/outbox';
import { listSwitchableAccounts } from '../offline/accounts';
import { takeSignedOutReason, SESSION_SUPERSEDED } from '../api/client';

function isOfflineError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.status) return false;
  const msg = (err.message || '').toLowerCase();
  return (
    err.name === 'TypeError' ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    msg.includes('abort')
  );
}

export default function LoginPage() {
  const { login, resumeOfflineSession, switchAccount } = useAuth();
  const navigate    = useNavigate();
  const { addToast } = useToast();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [unsentCount, setUnsentCount] = useState(0);
  const [resuming, setResuming] = useState(false);
  // ADR 0015 §3 — "Resume Offline Session". A last-known identity survives an
  // explicit logout or a 401 (client/src/context/AuthContext.jsx's LAST_IDENTITY_KEY),
  // so a device that has signed in before can get back in without connectivity.
  const [lastIdentity, setLastIdentity] = useState(null);
  // ADR 0017 #7 — the accounts this device has successfully signed in. Not gated on
  // V25_OFFLINE_CORE: that flag is the V2.5 offline core's switch, and this is ADR 0017,
  // which lands unflagged like the per-person accounts (slice 3) and device letters
  // (slice 4) it sits on top of.
  const [accounts, setAccounts] = useState([]);
  const [switching, setSwitching] = useState(null);

  // ADR 0017 #8 — why this screen is being shown, when it is not just "you logged out".
  // A takeover cannot reach a device that is offline, so this is how the person finds
  // out: on reconnect, at the moment their next request is refused.
  const [signedOutReason] = useState(() => takeSignedOutReason());

  useEffect(() => {
    listSwitchableAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    waitingCount()
      .then((count) => setUnsentCount(count))
      .catch(() => {});
    getLastKnownIdentity()
      .then(setLastIdentity)
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const me = await login(email, password);
      // ADR 0017 #8 — one session per account. Say so plainly when it actually did
      // something, rather than letting the other tablet just stop working unexplained.
      if (me?.session_replaced) {
        addToast('This account was signed out on the other device it was using.', 'success');
      }
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (isOfflineError(err)) {
        setError("You're offline. Connect to the internet to sign in.");
      } else {
        setError(err.message || 'Login failed. Please check your credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Two taps, no password, no server round trip — the ADR 0017 #7 switch, offered on the
  // login screen as well as inside the app because a tablet that has been signed out (or
  // that a takeover has just bounced here) still has to be able to sell during a blackout.
  const handlePickAccount = async (account) => {
    setError('');
    setSwitching(account.email);
    try {
      const result = await switchAccount(account.email);
      if (result) {
        navigate('/dashboard', { replace: true });
        return;
      }
      setError('That account is no longer remembered on this tablet — sign in with the password.');
    } finally {
      setSwitching(null);
    }
  };

  const handleResumeOffline = async () => {
    setError('');
    setResuming(true);
    try {
      const identity = await resumeOfflineSession();
      if (identity) {
        navigate('/dashboard', { replace: true });
      } else {
        setError('No offline session found on this device yet — connect once to sign in first.');
      }
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Leyble Hub</h1>
        <p className="text-slate-500 text-base mb-8">Sign in to your account</p>

        {V25_OFFLINE_CORE && unsentCount > 0 && (
          <div
            role="status"
            className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-sm font-semibold flex items-start gap-2.5 shadow-sm"
          >
            <span className="text-lg shrink-0">⚠️</span>
            <div>
              <p className="font-bold text-amber-950">
                This device is holding {unsentCount} unsent receipt{unsentCount === 1 ? '' : 's'}.
              </p>
              <p className="mt-0.5 text-xs text-amber-800 font-normal">
                Sales are saved locally and will automatically sync once connected to the server.
              </p>
            </div>
          </div>
        )}

        {signedOutReason === SESSION_SUPERSEDED && (
          <div
            role="status"
            className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-base"
          >
            <p className="font-semibold">This account was signed in on another device.</p>
            <p className="mt-0.5 text-sm">
              Sign in again to keep using it here. Anything this tablet had not sent yet is
              still saved on it and will sync once you are back in.
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-base font-medium"
          >
            {error}
          </div>
        )}

        {accounts.length > 0 && (
          <div className="mb-6">
            <p className="text-sm font-semibold text-slate-700 mb-2">Signed in before on this tablet</p>
            <ul className="flex flex-col gap-2">
              {accounts.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    onClick={() => handlePickAccount(account)}
                    disabled={switching !== null || loading}
                    data-testid={`login-account-${account.email}`}
                    className="w-full min-h-[60px] flex items-center gap-3 px-4 py-3 rounded-xl text-left
                               border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <span
                      aria-hidden="true"
                      className="flex items-center justify-center w-10 h-10 shrink-0 rounded-full
                                 bg-slate-800 text-white text-base font-bold"
                    >
                      {(account.full_name || account.email).trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-semibold text-slate-900 truncate">
                        {account.full_name || account.email}
                      </span>
                      {/* Status in text as well as colour, never colour alone. */}
                      <span className="block text-sm text-slate-500 truncate">
                        {account.has_token
                          ? 'Tap to continue — no password needed'
                          : 'Tap to work offline — password needed once there is internet'}
                      </span>
                    </span>
                    {switching === account.email && (
                      <span className="shrink-0 text-sm font-semibold text-slate-500">Opening…</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-slate-500">Or sign in with an email and password.</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
          <FormField label="Email address" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="josie@leyblestore.com"
              className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </FormField>

          <FormField label="Password" required>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </FormField>

          <Button type="submit" loading={loading} className="w-full mt-2">
            Sign in
          </Button>
        </form>

        {/* Pre-ADR-0017 devices have a last-known identity but no remembered-accounts
            list yet (it is only written by a sign-in on this build). The original
            single-identity resume stays for exactly that case and disappears once the
            list has anything in it. */}
        {V25_OFFLINE_CORE && lastIdentity && accounts.length === 0 && (
          <div className="mt-5 pt-5 border-t border-slate-200 text-center">
            <p className="text-sm text-slate-500 mb-3">
              Signed in before as {lastIdentity.full_name || lastIdentity.email} on this device.
            </p>
            <Button
              type="button"
              variant="secondary"
              loading={resuming}
              onClick={handleResumeOffline}
              className="w-full"
            >
              Resume Offline Session
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
