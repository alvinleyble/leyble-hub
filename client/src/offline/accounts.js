import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { REMEMBERED_ACCOUNTS_KEY } from './keys';

// ADR 0017 #7 — the accounts this device has successfully signed in, and switching
// between them offline.
//
// This is what replaces the profile picker slice 3 deleted, WITHOUT reintroducing a
// second way to say who is selling. The difference is not cosmetic: a profile was a
// persona anyone could pick from a list of people the app knew about, and this list is
// "accounts that have proven themselves on this tablet". A person's first sign-in on a
// device still needs a connection (ADR 0015 §2) — nothing is ever added here except by a
// login that actually succeeded against the server.
//
// The objection this answers: ADR 0015 §3 rejected an offline operator picker because it
// would bypass admin-versus-staff access control. There is no such access control and
// there never was — `users.role` is signed into the JWT and read by no route guard and no
// client gate — so ADR 0017 settles it in its Context section. Do not re-litigate it here.
//
// It is DEVICE state, not session state: it survives logout, a genuine 401 and a session
// takeover, for the same reason the outbox does (ADR 0015 §3). A tablet that forgot who
// its people were the moment a session ended would be a tablet that cannot say who is
// selling during a blackout, which is the exact hole the picker used to fill.
//
// The account's TOKEN is not stored here — see the comment on REMEMBERED_ACCOUNTS_KEY in
// keys.js, and `rememberAccountToken` in api/client.js. An entry with no held token is
// still worth keeping: it can still be switched to for an offline session, it just has to
// be signed in again once the line is back.

async function readAll() {
  const stored = await nativeStore.getJson(REMEMBERED_ACCOUNTS_KEY);
  return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
}

async function writeAll(map) {
  await nativeStore.setJson(REMEMBERED_ACCOUNTS_KEY, map);
}

function entryFor(identity, previous) {
  return {
    id: identity.id,
    email: identity.email,
    full_name: identity.full_name || previous?.full_name || null,
    role: identity.role || previous?.role || null,
    remembered_at: previous?.remembered_at || new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
}

/**
 * File an account that has just signed in successfully, with the token that proved it.
 *
 * Called from the ONE place a password was actually checked by the server (AuthContext's
 * `login`). Re-signing in updates the entry in place rather than adding a second one:
 * the account is the identity, and a device holds at most one entry per account.
 */
export async function rememberAccount(identity, token) {
  if (!identity?.email) return null;
  const map = await readAll();
  const key = String(identity.id ?? identity.email);
  const entry = entryFor(identity, map[key]);
  map[key] = entry;
  await writeAll(map);
  if (token) await api.rememberAccountToken(entry.email, token);
  return entry;
}

/** Every account this device remembers, most recently used first. */
export async function listRememberedAccounts() {
  const map = await readAll();
  return Object.values(map)
    .filter((a) => a && a.email)
    .sort((a, b) => String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')));
}

/**
 * The same list, each entry told whether this device still holds that account's token —
 * i.e. whether switching to it is a complete switch or an offline-only one that will ask
 * for the password as soon as the line is back (ADR 0015 §3's offline session, widened
 * from one identity to every account the device knows).
 */
export async function listSwitchableAccounts() {
  const accounts = await listRememberedAccounts();
  return Promise.all(accounts.map(async (account) => ({
    ...account,
    has_token: Boolean(await api.getAccountToken(account.email)),
  })));
}

export async function findRememberedAccount(idOrEmail) {
  if (idOrEmail === undefined || idOrEmail === null) return null;
  const map = await readAll();
  const direct = map[String(idOrEmail)];
  if (direct) return direct;
  const needle = String(idOrEmail).toLowerCase();
  return Object.values(map).find((a) => String(a?.email).toLowerCase() === needle) || null;
}

/** Moves an account to the top of the list. Called on every switch into it. */
export async function markAccountUsed(idOrEmail) {
  const account = await findRememberedAccount(idOrEmail);
  if (!account) return null;
  const map = await readAll();
  const updated = { ...account, last_used_at: new Date().toISOString() };
  map[String(account.id ?? account.email)] = updated;
  await writeAll(map);
  return updated;
}

/**
 * Drop an account from this device entirely, token included.
 *
 * The one destructive action here, and it is deliberately never automatic: not on logout,
 * not on a 401, not on a session takeover. Only a person saying "this account does not
 * belong on this tablet any more" removes it.
 */
export async function forgetAccount(idOrEmail) {
  const account = await findRememberedAccount(idOrEmail);
  if (!account) return false;
  const map = await readAll();
  delete map[String(account.id ?? account.email)];
  await writeAll(map);
  await api.forgetAccountToken(account.email);
  return true;
}
