import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { nativeStore } from './nativeStore.js';
import { SYNC_STATE_KEY } from './keys.js';
import { refreshEntity, applyCatalogueDelta } from './catalogue.js';
import { putOrderSnapshot } from './receiptHistory.js';

// ADR 0015 §4 / Slice 3.2 — EAGER SYNC AT SETUP, INCREMENTAL SYNC AFTER THAT.
//
// This replaces the "cache what you visit" model the earlier slices assumed. Field
// testing on Slice 3.1 showed why: an order that had been *viewed* online but never
// created on this tablet had no local copy at all, so opening it — or the whole
// Outgoing Orders list — offline failed. Caching on visit can only ever protect what
// the operator happened to open before the line went down, which is not how a counter
// works during a blackout.
//
// So the tablet pulls ahead of time, in two clearly different shapes:
//
//   FIRST-EVER SETUP (this device holds nothing yet) — one full pull, once, ever.
//   Products, customers and personnel first: small, fast, and the only things order
//   taking actually needs, so the app UNLOCKS the moment they land. The complete order
//   history then streams in behind the scenes, newest first, while the operator is
//   already working. Nobody waits on a loading screen for thousands of old invoices.
//
//   EVERY LOGIN AND RECONNECT AFTER THAT — a delta and nothing else. Whatever changed
//   since our last successful sync, in products, customers, personnel and orders,
//   including orders created on OTHER tablets. Step 1's full pull never runs again.
//
// Two rules hold both shapes together:
//
//   Throttled reconnects. A flaky link fires `online` repeatedly; a sync that starts
//   within RECONNECT_THROTTLE_MS of the last one finishing is skipped rather than
//   stacked. (A login is deliberate and is never throttled.)
//
//   Never clear-then-repopulate. Every write here MERGES onto what the device already
//   holds — catalogue deltas by id, order snapshots one key per order. A sync cut off
//   halfway therefore leaves the tablet with strictly MORE than it started with, never
//   less, and the cursors below mean the next attempt resumes rather than restarts.

const RECONNECT_THROTTLE_MS = 90_000;
const ORDER_PAGE_SIZE = 100;
// The order-history backfill is a background job on a device the operator is already
// using. Pages are pulled with a breath between them so a first setup on a big store's
// history never monopolises the connection the outbox drain also needs.
const BACKFILL_PAGE_GAP_MS = 400;

const REFERENCE_ENTITIES = ['products', 'customers', 'personnel'];

const EMPTY_STATE = {
  setup_complete: false,
  // Watermark per reference entity: the newest `updated_at` this device has seen for
  // it. Server-issued, so there is no clock-skew question — we never write our own
  // clock into a comparison the server will make.
  reference_watermarks: {},
  // Newest (updated_at, id) seen in order history: where the forward delta resumes.
  orders_delta_cursor: null,
  // Oldest (updated_at, id) pulled so far going backwards: where the first-setup
  // backfill resumes if it was interrupted.
  orders_backfill_cursor: null,
  orders_backfill_complete: false,
  last_sync_completed_at: 0,
};

// ── State ───────────────────────────────────────────────────────────────────

export async function getSyncState() {
  const stored = await nativeStore.getJson(SYNC_STATE_KEY);
  return { ...EMPTY_STATE, ...(stored || {}) };
}

async function patchSyncState(patch) {
  const next = { ...(await getSyncState()), ...patch };
  await nativeStore.setJson(SYNC_STATE_KEY, next);
  return next;
}

/**
 * True on a tablet that has never completed its one-time full pull. This is the ONLY
 * thing that decides between the two shapes above — not "is the cache empty", which a
 * transient read failure could fake.
 */
export async function isFirstSetup() {
  return !(await getSyncState()).setup_complete;
}

// ── Observers ───────────────────────────────────────────────────────────────

let snapshot = {
  phase: 'idle',          // 'idle' | 'setup' | 'syncing'
  firstSetup: false,
  essentialsReady: true,  // false only while a first setup's reference pull is running
  error: null,
  ordersBackfilling: false,
  ordersSynced: 0,
};

const listeners = new Set();

export function getSyncSnapshot() {
  return snapshot;
}

export function subscribeSync(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    try { listener(snapshot); } catch {}
  }
}

// ── Cursors ─────────────────────────────────────────────────────────────────
//
// Cursors are minted by the SERVER and echoed back verbatim; this module never builds
// one from an order's `updated_at`. JSON timestamps are millisecond-precision while
// Postgres stores microseconds, so a home-made cursor lands fractionally before the
// row it is supposed to mark — that row then reappears in every future delta, and a
// page made entirely of such rows never advances the cursor at all.

// ── Reference data ──────────────────────────────────────────────────────────

const maxUpdatedAt = (rows) =>
  rows.reduce((max, r) => (r?.updated_at && String(r.updated_at) > String(max) ? String(r.updated_at) : max), '');

/**
 * Pulls one reference entity and returns its new watermark.
 *
 * `since` absent → the full pull (first setup only). `since` present → the delta.
 * Either way the watermark comes from the rows the SERVER sent, so it is the server's
 * own notion of time; an empty delta simply leaves the watermark where it was.
 */
async function syncReferenceEntity(entity, since) {
  if (!since) {
    const rows = await refreshEntity(entity);
    return maxUpdatedAt(rows) || null;
  }
  const rows = await api.get(
    `/${entity}?include_inactive=true&updated_since=${encodeURIComponent(since)}`
  );
  const list = Array.isArray(rows) ? rows : [];
  await applyCatalogueDelta(entity, list);
  return maxUpdatedAt(list) || since;
}

// ── Order history ───────────────────────────────────────────────────────────

async function fetchOrderPage({ direction, cursor, limit = ORDER_PAGE_SIZE }) {
  const params = new URLSearchParams({ direction, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const res = await api.get(`/orders/sync?${params}`);
  return {
    orders: Array.isArray(res?.orders) ? res.orders : [],
    hasMore: Boolean(res?.has_more),
    firstCursor: res?.first_cursor || null,
    nextCursor: res?.next_cursor || null,
  };
}

async function storeOrders(orders) {
  for (const order of orders) {
    await putOrderSnapshot(order);
  }
}

/**
 * Forward delta: everything created or changed anywhere (this tablet or another one)
 * since the newest row we already hold. Runs on every login and every reconnect.
 */
async function syncOrderDelta(state) {
  let cursor = state.orders_delta_cursor;
  let synced = 0;

  // A device with no cursor at all has never pulled history; the backfill below owns
  // that case, and running a "delta from the beginning" here would be the full pull
  // this design exists to avoid repeating.
  if (!cursor) return { cursor, synced };

  for (;;) {
    const { orders, hasMore, nextCursor } = await fetchOrderPage({ direction: 'forward', cursor });
    if (orders.length === 0) break;
    await storeOrders(orders);
    synced += orders.length;
    // A page that comes back without a usable cursor would otherwise re-request
    // itself forever; stop instead and let the next sync try again from here.
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await patchSyncState({ orders_delta_cursor: cursor });
    publish({ ordersSynced: snapshot.ordersSynced + orders.length });
    if (!hasMore) break;
  }

  return { cursor, synced };
}

/**
 * Backward backfill: the rest of history, newest page first, resuming from wherever a
 * previous attempt stopped. This is the part that streams in behind an unlocked app on
 * a first setup — and the part that quietly finishes itself on later logins if a first
 * setup was interrupted before it got through everything.
 */
let backfilling = false;

async function backfillOrderHistory() {
  // A backfill left streaming in the background outlives the runSync() that started
  // it, so a later login/reconnect can land while one is still going. Let it finish
  // rather than starting a second one racing it down the same cursor.
  if (backfilling) return;
  backfilling = true;
  publish({ ordersBackfilling: true });
  try {
    for (;;) {
      const state = await getSyncState();
      if (state.orders_backfill_complete) break;

      const { orders, hasMore, firstCursor, nextCursor } = await fetchOrderPage({
        direction: 'back',
        cursor: state.orders_backfill_cursor,
      });

      if (orders.length === 0) {
        await patchSyncState({ orders_backfill_complete: true });
        break;
      }

      await storeOrders(orders);
      publish({ ordersSynced: snapshot.ordersSynced + orders.length });

      const stalled = !nextCursor || nextCursor === state.orders_backfill_cursor;
      const patch = { orders_backfill_cursor: nextCursor || state.orders_backfill_cursor };
      // The very first backward page is the newest slice of history there is, so its
      // first row is exactly where the forward delta should pick up from next time.
      if (!state.orders_delta_cursor && firstCursor) patch.orders_delta_cursor = firstCursor;
      if (!hasMore || stalled) patch.orders_backfill_complete = true;
      await patchSyncState(patch);

      if (!hasMore || stalled) break;
      if (BACKFILL_PAGE_GAP_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, BACKFILL_PAGE_GAP_MS));
      }
    }
  } catch {
    // Interrupted (the line dropped, the server blinked). Everything already fetched
    // stays exactly where it is, and the cursor written after the last successful page
    // means the next login resumes from there rather than starting over.
  } finally {
    backfilling = false;
    publish({ ordersBackfilling: false });
  }
}

// ── The sync itself ─────────────────────────────────────────────────────────

let inFlight = null;

/**
 * @param {object}  [opts]
 * @param {string}  [opts.trigger]  'login' (deliberate, never throttled) | 'reconnect'
 * @param {boolean} [opts.waitForOrders] await the order-history backfill instead of
 *                  letting it stream in the background. Tests use it; the app never does.
 */
export async function runSync({ trigger = 'login', waitForOrders = false } = {}) {
  if (inFlight) return { skipped: true, reason: 'in-flight' };

  const state = await getSyncState();

  if (trigger === 'reconnect') {
    const since = Date.now() - (state.last_sync_completed_at || 0);
    if (state.last_sync_completed_at && since < RECONNECT_THROTTLE_MS) {
      return { skipped: true, reason: 'throttled', retryInMs: RECONNECT_THROTTLE_MS - since };
    }
  }

  const firstSetup = !state.setup_complete;
  inFlight = (async () => {
    publish({
      phase: firstSetup ? 'setup' : 'syncing',
      firstSetup,
      essentialsReady: !firstSetup,
      error: null,
    });

    const result = { ran: true, firstSetup, entitiesSynced: [], ordersSynced: 0, error: null };

    try {
      // 1. Reference data. Per entity, so one failing endpoint cannot roll back the
      //    watermarks of the two that did land.
      const watermarks = { ...(state.reference_watermarks || {}) };
      for (const entity of REFERENCE_ENTITIES) {
        try {
          watermarks[entity] = await syncReferenceEntity(entity, firstSetup ? null : watermarks[entity]);
          result.entitiesSynced.push(entity);
        } catch (err) {
          result.error = err;
        }
      }
      await patchSyncState({ reference_watermarks: watermarks });

      // A first setup is only "complete" once the three things order taking needs are
      // actually held. Anything short of that must stay a first setup, or the next
      // login would run a delta against a tablet holding nothing.
      const essentialsReady = REFERENCE_ENTITIES.every((e) => result.entitiesSynced.includes(e));
      if (firstSetup && essentialsReady) await patchSyncState({ setup_complete: true });
      publish({ essentialsReady: essentialsReady || !firstSetup });

      // 2. Order history. The forward delta first (cheap, and the part that matters
      //    for orders other tablets just created), then whatever backfill is still owed.
      try {
        const { synced } = await syncOrderDelta(await getSyncState());
        result.ordersSynced += synced;
      } catch (err) {
        result.error = result.error || err;
      }

      const afterDelta = await getSyncState();
      if (!afterDelta.orders_backfill_complete) {
        const backfill = backfillOrderHistory();
        if (waitForOrders) await backfill;
      }

      await patchSyncState({ last_sync_completed_at: Date.now() });
      return result;
    } catch (err) {
      result.error = err;
      return result;
    } finally {
      // The gate always releases: a first setup that could not reach the server leaves
      // the app usable (and still flagged first-setup, so the next login retries the
      // full pull) rather than stranding the operator on a spinner.
      publish({ phase: 'idle', error: result.error || null });
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * React view of the first-setup gate: `blocking` is true only while a tablet that has
 * never been set up is still pulling the three things order taking needs. Order history
 * is deliberately absent from it — that streams in behind an unlocked app.
 */
export function useSyncGate() {
  const [state, setState] = useState(() => getSyncSnapshot());
  useEffect(() => subscribeSync(setState), []);
  return {
    blocking: state.phase === 'setup' && !state.essentialsReady,
    firstSetup: state.firstSetup,
    ordersBackfilling: state.ordersBackfilling,
    ordersSynced: state.ordersSynced,
    error: state.error,
  };
}

// Test seams.
export const __SYNC_INTERNALS = { RECONNECT_THROTTLE_MS, ORDER_PAGE_SIZE };

export async function __resetSyncState() {
  inFlight = null;
  snapshot = {
    phase: 'idle', firstSetup: false, essentialsReady: true,
    error: null, ordersBackfilling: false, ordersSynced: 0,
  };
  await nativeStore.remove(SYNC_STATE_KEY);
}
