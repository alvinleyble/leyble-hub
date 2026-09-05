import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { markOffline } from '../offline/status.js';

const BASE = (import.meta.env.VITE_API_URL || '') + '/api/v1';

// Lie-Fi detection — a request that never even fails, just hangs (a captive portal, a
// dead upstream link that still accepts the TCP connection), used to cost every caller
// 60-120s of browser/fetch default timeout before anything told the operator. Every
// request now aborts after REQUEST_TIMEOUT_MS so a black-holed network fails fast
// instead of hanging the screen.
const REQUEST_TIMEOUT_MS = 5000;

// Web (dev) authenticates with an HTTP-only cookie. The native Android app
// (Capacitor) can't use SameSite=strict cookies cross-origin, so it stores the
// JWT in @capacitor/preferences (native, app-sandboxed storage — NOT browser
// localStorage) and sends it as an Authorization: Bearer header instead.
const isNative = Capacitor.isNativePlatform();
const TOKEN_KEY = 'authToken';
// The account signed in on this device. ADR 0017 §5 deleted profiles, so this is no
// longer a picked persona — it is written from the login response and cleared on logout
// or a genuine 401, exactly like the token beside it. Nothing is sent to the server from
// it: the JWT already carries the identity. It exists so a record queued in the outbox
// can record WHO SAVED IT locally (D14) even after the app is closed and reopened.
const ACCOUNT_KEY = 'activeProfile';

// ADR 0017 #7 — the token this device holds for each REMEMBERED account, so switching
// back to one is two taps and no password. One key per account, exactly like the outbox's
// one key per record: signing in as Josie must not overwrite the token that still lets
// this tablet speak as Alvin.
//
// Keyed by EMAIL, not by row id, because the email is what everything on the device
// already calls an account: `activeProfile` beside it holds one, and so does every queued
// outbox record's `profile_key` (D14). Keying by id would mean a lookup — and a lookup
// through offline/accounts.js, which imports this module.
//
// Native only, deliberately. The web dev tier authenticates with an HTTP-only cookie and
// a JWT must never be put where page script can read it back (CLAUDE.md security rules),
// so on the web these live in memory for the life of the page and no further. The
// consequence is honest and small: after a browser reload the dev tier can still SWITCH
// to a remembered account (that is ADR 0015 §3's offline session, and it is the whole
// point of the feature), but it will be asked for the password the moment the line is
// back. On the APK — the only thing that is ever a station (ADR 0011) — the token
// persists and the switch is complete.
const ACCOUNT_TOKEN_PREFIX = 'accountToken.';
const memoryAccountTokens = new Map();

// Which account the browser's HTTP-only cookie was minted for (web dev only; never a
// secret, just an email). Without it, switching to a remembered account this browser
// holds no token for would silently fall back to the PREVIOUS account's cookie and write
// their name onto this person's sales — see `request` below, which omits the cookie
// rather than misattribute.
const COOKIE_ACCOUNT_KEY = 'cookieAccount';

// The server's `code` for "this account signed in somewhere else" (ADR 0017 #8), and the
// one-shot sessionStorage slot the login screen reads it back out of.
export const SESSION_SUPERSEDED = 'session_superseded';
export const SIGNED_OUT_REASON_KEY = 'leyble_signed_out_reason';

// Reads and clears the reason this device was bounced to the login screen, if there was
// one. One-shot on purpose: it explains the sign-out that just happened, and must not
// still be sitting there the next time someone opens the app.
export function takeSignedOutReason() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const reason = sessionStorage.getItem(SIGNED_OUT_REASON_KEY);
    if (reason) sessionStorage.removeItem(SIGNED_OUT_REASON_KEY);
    return reason;
  } catch {
    return null;
  }
}

// The web dev tier keeps its active token in memory only (see ACCOUNT_TOKEN_PREFIX
// below): a JWT must never be put where page script can read it back after a reload.
// Before ADR 0017 #7 the web path held no token at all and rode entirely on the cookie;
// it needs one now because one cookie can only ever name one account, and a device that
// remembers two has to be able to say which one is selling.
let memoryToken = null;

async function getToken() {
  if (!isNative) return memoryToken;
  const { value } = await Preferences.get({ key: TOKEN_KEY });
  return value || null;
}

async function setToken(token) {
  if (!isNative) { memoryToken = token || null; return; }
  if (token) await Preferences.set({ key: TOKEN_KEY, value: token });
  else await Preferences.remove({ key: TOKEN_KEY });
}

// Who is signed in on this device, as a stable string (the account's email).
// Native: @capacitor/preferences (app-sandboxed, survives restarts). Web dev: localStorage.
// The storage key keeps its pre-0017 name so a device upgrading mid-outage does not lose
// the value already sitting beside its still-queued outbox records.
// The `typeof localStorage` guards are not decoration: these are read on the drain path
// now (to decide whether a queued record needs its author's own token), and that path
// also runs under the plain Node test runner, where there is no browser storage at all.
async function getActiveProfile() {
  if (!isNative) {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(ACCOUNT_KEY);
  }
  const { value } = await Preferences.get({ key: ACCOUNT_KEY });
  return value || null;
}

async function setActiveProfile(accountKey) {
  if (!isNative) {
    if (typeof localStorage === 'undefined') return;
    if (accountKey) localStorage.setItem(ACCOUNT_KEY, accountKey);
    else localStorage.removeItem(ACCOUNT_KEY);
    return;
  }
  if (accountKey) await Preferences.set({ key: ACCOUNT_KEY, value: accountKey });
  else await Preferences.remove({ key: ACCOUNT_KEY });
}

// ── Per-account tokens (ADR 0017 #7) ────────────────────────────────────────

function accountTokenKey(accountKey) {
  return `${ACCOUNT_TOKEN_PREFIX}${accountKey}`;
}

async function rememberAccountToken(accountKey, token) {
  if (!accountKey || !token) return;
  if (!isNative) { memoryAccountTokens.set(accountKey, token); return; }
  await Preferences.set({ key: accountTokenKey(accountKey), value: token });
}

async function getAccountToken(accountKey) {
  if (!accountKey) return null;
  if (!isNative) return memoryAccountTokens.get(accountKey) || null;
  const { value } = await Preferences.get({ key: accountTokenKey(accountKey) });
  return value || null;
}

// Drops one account's token and nothing else. Called when the server has actually
// refused it — a session takeover (ADR 0017 #8), a deactivated account, an explicit
// logout — so the switcher can say "password needed" instead of offering a switch that
// would fail. It never touches the outbox, the receipt history or the other accounts'
// tokens: those are device state (ADR 0015 §3).
async function forgetAccountToken(accountKey) {
  if (!accountKey) return;
  if (!isNative) { memoryAccountTokens.delete(accountKey); return; }
  await Preferences.remove({ key: accountTokenKey(accountKey) });
}

// Makes `accountKey`'s remembered token the one every ordinary request goes out under —
// this IS the account switch, as far as the wire is concerned. Answers false when this
// device holds no token for that account: the switch still happens locally (an offline
// session, ADR 0015 §3), it just cannot prove itself to the server yet.
async function useAccountToken(accountKey) {
  const token = await getAccountToken(accountKey);
  await setToken(token);
  return Boolean(token);
}

// Web dev only — see COOKIE_ACCOUNT_KEY above.
function setCookieAccount(email) {
  if (isNative || typeof localStorage === 'undefined') return;
  try {
    if (email) localStorage.setItem(COOKIE_ACCOUNT_KEY, email);
    else localStorage.removeItem(COOKIE_ACCOUNT_KEY);
  } catch {}
}

function getCookieAccount() {
  if (isNative || typeof localStorage === 'undefined') return null;
  try { return localStorage.getItem(COOKIE_ACCOUNT_KEY); } catch { return null; }
}

// ADR 0017 §5 — there is no `X-Active-Profile` header any more. Each person signs in
// with their own account, so the JWT alone says who is acting and the server has nothing
// to swap. The outbox still stores the account that made each record (D14), but that is
// now local-only bookkeeping; slice 5's remembered accounts is what will give it a wire
// form again once one device can hold more than one signed-in person.
async function request(path, options = {}) {
  // `profileKey` is pulled off and dropped rather than ignored in place, so a caller
  // still passing the per-record author (the outbox drain does) can't leak it into fetch.
  //
  // `accountKey` (ADR 0017 #7) sends this ONE request under a remembered account's own
  // token instead of the active one. That is how the outbox drains a record under the
  // account that SAVED it (D14) rather than whoever happens to be holding the tablet when
  // the line returns — the per-record author back on the wire, as a real credential
  // rather than the impersonation header ADR 0017 §5 deleted. A 401 on such a request
  // forgets THAT account's token and nothing else: it is a stale credential for someone
  // who is not even using the device, not a reason to sign the current person out.
  const { profileKey: _localAuthor, accountKey, ...fetchOptions } = options;
  const asAccount = Boolean(accountKey);

  const headers = { 'Content-Type': 'application/json', ...fetchOptions.headers };
  const token = asAccount ? await getAccountToken(accountKey) : await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // The cookie is only ever safe when it names the account we mean to speak as. On the
  // web dev tier, switching to a remembered account this browser holds no token for
  // would otherwise fall through to the previous account's cookie and file the sale
  // under their name — so the cookie is left off and the server answers 401, which is
  // the honest outcome: sign in once and the switch is complete.
  // Native has no cookie at all, so this whole check reads one local value and stops.
  // Sign-in and sign-out are the exception in both directions: the login response IS how
  // the browser gets its cookie (it is never stored on a request sent without
  // credentials), and logout has to send the one it is clearing.
  const isAuthTransition = path === '/auth/login' || path === '/auth/logout';
  const cookieAccount = getCookieAccount();
  const cookieNamesSomeoneElse = !isAuthTransition && Boolean(cookieAccount)
    && cookieAccount !== (await getActiveProfile());
  const useCookie = isAuthTransition || (!token && !asAccount && !cookieNamesSomeoneElse);

  // Lie-Fi: a request that hangs (dead upstream, captive portal) is indistinguishable
  // from a slow one until something imposes a deadline. `controller` is what enforces
  // REQUEST_TIMEOUT_MS; a caller-supplied `signal` (component unmount, cancelled search)
  // is combined in rather than overridden, and its own abort must NOT be read as a
  // network failure below.
  const callerSignal = fetchOptions.signal;
  let timedOut = false;
  let callerAborted = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  let onCallerAbort;
  if (callerSignal) {
    if (callerSignal.aborted) {
      callerAborted = true;
      controller.abort();
    } else {
      onCallerAbort = () => { callerAborted = true; controller.abort(); };
      callerSignal.addEventListener('abort', onCallerAbort);
    }
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: useCookie ? 'include' : 'omit',
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    // A rejected fetch here is a network error, a DNS failure, or our own timeout abort
    // — the request never reached the server at all. That is the Lie-Fi signal: flip to
    // offline immediately rather than waiting for the caller to notice a hung screen or
    // for the next periodic probe. A caller-initiated abort is not a network condition
    // and must not flip the app offline.
    if (timedOut) err.timedOut = true;
    if (!callerAborted) markOffline();
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort);
  }

  if (res.status === 401) {
    // ADR 0017 #8 — a takeover is the one 401 that has a story worth telling. The
    // redirect below is a full page load, so the reason is left where the login screen
    // can pick it up; sessionStorage because it is a one-shot message for this tab, not
    // device state (nothing under `v25.` is touched by a 401 — that is the hard
    // requirement, and it is what keeps the outbox intact through one).
    const superseded = await res.clone().json().then(
      (b) => b?.code === SESSION_SUPERSEDED, () => false,
    );
    if (superseded && typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem(SIGNED_OUT_REASON_KEY, SESSION_SUPERSEDED); } catch {}
    }

    if (asAccount) {
      // Someone else's remembered token has gone stale — a session takeover on their
      // other device (ADR 0017 #8), or their account was deactivated. Drop just that
      // token so the switcher asks for their password next time. The record that was
      // being sent stays exactly where it is; the drain decides what to do next.
      await forgetAccountToken(accountKey);
      const err = new Error('Unauthenticated');
      err.status = 401;
      err.accountKey = accountKey;
      throw err;
    }
    // Clears session state by name only. D15: the device's station number, its waiting
    // receipts and its local receipt history live under the `v25.` prefix and are
    // device state, not session state — they must survive logout and re-login, so this
    // must never become a prefix sweep of native storage. ADR 0017 #8 leans on exactly
    // that: a session takeover ends the SESSION, and the receipts this device is still
    // holding are not part of it.
    const signedOut = await getActiveProfile();
    await setToken(null);
    await setActiveProfile(null);
    setCookieAccount(null);
    await forgetAccountToken(signedOut);
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    const err = new Error('Unauthenticated');
    err.status = 401;
    throw err;
  }

  const contentType = res.headers.get('Content-Type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // Persist / clear the token around auth transitions. AuthContext is what files the
  // account into the remembered list (offline/accounts.js); this only moves the ACTIVE
  // token, which is the one every ordinary request rides on.
  if (path === '/auth/login' && data?.token) {
    await setToken(data.token);
    if (data.email) setCookieAccount(data.email);
  }
  if (path === '/auth/logout') {
    await setToken(null);
    await setActiveProfile(null);
    setCookieAccount(null);
  }

  return data;
}

export const api = {
  get:   (path,       opts) => request(path, { ...opts }),
  post:  (path, body, opts) => request(path, { ...opts, method: 'POST',  body: JSON.stringify(body) }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: JSON.stringify(body) }),
  del:   (path,       opts) => request(path, { ...opts, method: 'DELETE' }),
  // The outbox drain builds its own request (method and body come off the queued
  // record), so it needs the raw form.
  request,
  getActiveProfile,
  setActiveProfile,
  // ADR 0017 #7 — remembered-account tokens. `offline/accounts.js` owns the list; these
  // own the credential, which is deliberately kept out of `v25.` storage (see the
  // comment on ACCOUNT_TOKEN_PREFIX).
  rememberAccountToken,
  getAccountToken,
  forgetAccountToken,
  useAccountToken,
  setCookieAccount,
};
