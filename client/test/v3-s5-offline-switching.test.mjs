// ADR 0017 slice 5 — remembered accounts, offline switching, one session per account.
//
// This is what replaces the profile picker slice 3 deleted. What has to be right is not
// the list itself but the three things around it:
//
//   • a switch is LOCAL — no password, no server round trip — so it works mid-blackout,
//     and the next receipt is numbered and signed as the person who was picked;
//   • a queued record still drains under the account that SAVED it, now that one device
//     can hold two signed-in people;
//   • the HARD REQUIREMENT of ADR 0017 #8: a session takeover must NEVER discard
//     receipts waiting to sync. They are device state, not session state.
//
// The server half — minting the session, refusing a superseded token, letting a
// letter-less pre-0017 token through the switchover window — is in
// server/test/v3-s5-offline-switching.test.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { REMEMBERED_ACCOUNTS_KEY } from '../src/offline/keys.js';
import {
  rememberAccount, listRememberedAccounts, listSwitchableAccounts,
  findRememberedAccount, markAccountUsed, forgetAccount,
} from '../src/offline/accounts.js';
import {
  enqueue, drainOutbox, listRecords, waitingCount, listNeedsAttention,
  __clearOutbox, QUEUED,
} from '../src/offline/outbox.js';

const ALVIN = { id: 1, email: 'alvin@leyblestore.com', full_name: 'Admin', role: 'admin' };
const JOSIE = { id: 2, email: 'josie@leyblestore.com', full_name: 'Josie', role: 'admin' };

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  localStorage.clear();
  savedApi = { request: api.request, post: api.post };
  // Every account token from a previous case, gone: on this (web) tier they live in a
  // module-level Map, which no store reset can reach.
  for (const email of [ALVIN.email, JOSIE.email]) await api.forgetAccountToken(email);
  await api.setActiveProfile(null);
});

afterEach(() => {
  api.request = savedApi.request;
  api.post = savedApi.post;
});

// ── The list itself ─────────────────────────────────────────────────────────

test('an account is remembered only by a sign-in, and re-signing in updates it in place', async () => {
  await rememberAccount(ALVIN, 'token-alvin');
  await rememberAccount(JOSIE, 'token-josie');
  await rememberAccount({ ...ALVIN, full_name: 'Alvin' }, 'token-alvin-2');

  const list = await listRememberedAccounts();
  assert.equal(list.length, 2, 'two accounts, not three — the account is the identity');
  assert.equal((await findRememberedAccount(ALVIN.email)).full_name, 'Alvin', 'updated in place');
  assert.equal(await api.getAccountToken(ALVIN.email), 'token-alvin-2', 'newest token wins');
  assert.equal(await api.getAccountToken(JOSIE.email), 'token-josie', "and never clobbers someone else's");
});

test('the list says which accounts can switch without a password', async () => {
  await rememberAccount(ALVIN, 'token-alvin');
  await rememberAccount(JOSIE, null); // remembered, but this device holds no token

  const list = await listSwitchableAccounts();
  const byEmail = Object.fromEntries(list.map((a) => [a.email, a]));
  assert.equal(byEmail[ALVIN.email].has_token, true);
  assert.equal(byEmail[JOSIE.email].has_token, false,
    'still offered — ADR 0015 §3 offline session — but it will ask for the password on reconnect');
});

test('the most recently used account leads the list', async () => {
  await rememberAccount(ALVIN, 'a');
  await rememberAccount(JOSIE, 'j');
  await markAccountUsed(ALVIN.email);
  assert.equal((await listRememberedAccounts())[0].email, ALVIN.email);
});

test('forgetting an account takes its token with it and leaves the others alone', async () => {
  await rememberAccount(ALVIN, 'a');
  await rememberAccount(JOSIE, 'j');

  assert.equal(await forgetAccount(JOSIE.email), true);
  assert.equal(await api.getAccountToken(JOSIE.email), null);
  assert.equal((await listRememberedAccounts()).length, 1);
  assert.equal(await api.getAccountToken(ALVIN.email), 'a', "Alvin's token is untouched");
});

test('no JWT is ever written into the remembered-accounts record itself', async () => {
  await rememberAccount(ALVIN, 'token-alvin');
  const raw = JSON.stringify(await nativeStore.getJson(REMEMBERED_ACCOUNTS_KEY));
  assert.ok(!raw.includes('token-alvin'),
    'the token lives in api/client.js, which keeps it out of the localStorage-backed dev store');
});

// ── Draining under the account that saved the record (D14 back on the wire) ──

test('a queued record drains under its own author\'s remembered token', async () => {
  await rememberAccount(ALVIN, 'token-alvin');
  await rememberAccount(JOSIE, 'token-josie');
  // Josie is holding the tablet when the line comes back...
  await api.setActiveProfile(JOSIE.email);

  const seen = [];
  api.request = async (path, opts) => { seen.push({ path, accountKey: opts.accountKey }); return { id: 9 }; };

  // ...but this sale was Alvin's.
  await enqueue({ entityType: 'order', endpoint: '/orders', payload: {}, profileKey: ALVIN.email });
  await drainOutbox();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountKey, ALVIN.email,
    "sent as Alvin — `created_by` is what prints `Sold by:` on the receipt (ADR 0017 #10)");
});

test('a record saved by whoever is signed in now rides the ordinary active token', async () => {
  await rememberAccount(JOSIE, 'token-josie');
  await api.setActiveProfile(JOSIE.email);

  const seen = [];
  api.request = async (path, opts) => { seen.push(opts.accountKey); return { id: 9 }; };

  await enqueue({ entityType: 'order', endpoint: '/orders', payload: {}, profileKey: JOSIE.email });
  await drainOutbox();

  assert.equal(seen[0], undefined, 'no per-account override — the cheapest and commonest path');
});

test("a record whose author's token has gone falls back to the active session", async () => {
  await rememberAccount(ALVIN, null); // remembered, token already dropped by a takeover
  await rememberAccount(JOSIE, 'token-josie');
  await api.setActiveProfile(JOSIE.email);

  const seen = [];
  api.request = async (path, opts) => { seen.push(opts.accountKey); return { id: 9 }; };

  await enqueue({ entityType: 'order', endpoint: '/orders', payload: {}, profileKey: ALVIN.email });
  await drainOutbox();

  assert.equal(seen[0], undefined,
    'attribution is honour-system by accepted design — a receipt still has to reach the server');
});

// ── The hard requirement (ADR 0017 #8) ──────────────────────────────────────

test('HARD REQUIREMENT — a session takeover never discards receipts waiting to sync', async () => {
  await rememberAccount(JOSIE, 'token-josie');
  await api.setActiveProfile(JOSIE.email);

  for (const receipt of ['2A-00001', '2A-00002', '2A-00003']) {
    await enqueue({
      entityType: 'order', endpoint: '/orders', payload: { receipt_number: receipt },
      profileKey: JOSIE.email, receiptNumber: receipt,
    });
  }
  assert.equal(await waitingCount(), 3);

  // The takeover: this account signed in on another device, so every request from here
  // is refused. It is a SERVER-SIDE act — this device only finds out when it next speaks.
  api.request = async () => {
    const err = new Error('Unauthenticated');
    err.status = 401;
    throw err;
  };
  const result = await drainOutbox();

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0, 'a dead session is not a bad record');
  assert.equal(await waitingCount(), 3, 'all three receipts are still waiting');
  assert.equal((await listNeedsAttention()).length, 0,
    'and none of them was turned into a chore for a human — nothing is wrong with them');
  const records = await listRecords();
  assert.deepEqual(records.map((r) => r.status), [QUEUED, QUEUED, QUEUED]);
  assert.deepEqual(
    records.map((r) => r.payload.receipt_number),
    ['2A-00001', '2A-00002', '2A-00003'],
    'unchanged, in order, ready for the sign-in that follows',
  );

  // And they go the moment the session is good again.
  api.request = async () => ({ id: 1 });
  const after = await drainOutbox();
  assert.equal(after.sent, 3);
  assert.equal(await waitingCount(), 0);
});

test('the remembered-accounts list itself survives a takeover', async () => {
  await rememberAccount(ALVIN, 'token-alvin');
  await rememberAccount(JOSIE, 'token-josie');

  // What the 401 path is allowed to clear: the refused account's own credential.
  await api.forgetAccountToken(JOSIE.email);

  const list = await listSwitchableAccounts();
  assert.equal(list.length, 2, 'both people are still known to this tablet');
  const josie = list.find((a) => a.email === JOSIE.email);
  assert.equal(josie.has_token, false, 'Josie is asked for her password next time');
  assert.equal(list.find((a) => a.email === ALVIN.email).has_token, true,
    "and Alvin, who was not signed in anywhere else, can still switch in with two taps");
});
