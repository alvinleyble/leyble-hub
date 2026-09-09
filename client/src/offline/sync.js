import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { nativeStore } from './nativeStore.js';
import { SYNC_STATE_KEY } from './keys.js';
import { refreshEntity, applyCatalogueDelta } from './catalogue.js';
import { putOrderSnapshot } from './receiptHistory.js';

// ADR 0015 §4 / Slice 3.2, revised by ADR 0019 — EAGER SYNC AT SETUP, INCREMENTAL SYNC
// AFTER THAT.
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
//   FIRST-EVER SETUP (this device holds nothing yet, or a previous first setup never
//   finished) — one full pull, once, ever. Products, customers and personnel land
//   first — small and fast — but ADR 0019 settled that the app stays gated behind one
//   truthful setup screen until the COMPLETE order history has also landed. Unlocking
//   the moment reference data arrives (the original Slice 3.2 design) shipped a device
//   that could take an order against a history it did not actually hold yet; the gate
//   now only lifts once `orders_backfill_complete` is true, and reopens on a later
//   login/resume ONLY if that backfill never finished — never for an ordinary delta.
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
const RECENT_UPDATE_MS = 4_000;
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
 * True while this device's one-time first setup — reference data AND the complete
 * order history — has never fully finished (ADR 0019's "Complete first setup"). This
 * is what the app gate blocks on. It is NOT "is the cache empty", which a transient
 * read failure could fake, and it is deliberately broader than "have the essentials
 * landed" — a device that has products/customers/personnel but never finished its
 * order-history backfill is still mid-first-setup.
 */
function isFirstSetupPending(state) {
  return !state.setup_complete || !state.orders_backfill_complete;
}

export async function isFirstSetup() {
  return isFirstSetupPending(await getSyncState());
}

// ── Observers ───────────────────────────────────────────────────────────────

let snapshot = {
  phase: 'idle',              // 'idle' | 'setup' | 'syncing'
  // Durable — ADR 0019: true until this device's first setup (essentials AND the
  // complete order history) has finished at least once. Unlike `phase`, this does NOT
  // go false just because the run that was chasing it idled out or failed; it only
  // clears once the persisted state actually shows both pulls complete. This is what
  // the app gate (useSyncGate().blocking) reads.
  firstSetupPending: false,
  essentialsReady: true,      // false only while a first setup's reference pull is running
  error: null,
  ordersBackfilling: false,
  ordersSynced: 0,
  orderCheck: 'idle',         // 'idle' | 'checking'
  recentlyUpdated: false,     // true briefly, and only when order data actually changed
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
  const changedOrders = [];

  // A device with no cursor at all has never pulled history; the backfill below owns
  // that case, and running a "delta from the beginning" here would be the full pull
  // this design exists to avoid repeating.
  if (!cursor) return { cursor, synced, orders: changedOrders };

  for (;;) {
    const { orders, hasMore, nextCursor } = await fetchOrderPage({ direction: 'forward', cursor });
    if (orders.length === 0) break;
    await storeOrders(orders);
    changedOrders.push(...orders);
    synced += orders.length;
    // A page that comes back without a usable cursor would otherwise re-request
    // itself forever; stop instead and let the next sync try again from here.
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await patchSyncState({ orders_delta_cursor: cursor });
    publish({ ordersSynced: snapshot.ordersSynced + orders.length });
    if (!hasMore) break;
  }

  return { cursor, synced, orders: changedOrders };
}

let recentUpdateTimer = null;

function notifyOrdersChanged(orders) {
  if (!orders.length) return;
  const byId = new Map(orders.map((order) => [String(order.id), order]));
  const changed = [...byId.values()];
  publish({ recentlyUpdated: true });
  if (recentUpdateTimer) clearTimeout(recentUpdateTimer);
  recentUpdateTimer = setTimeout(() => publish({ recentlyUpdated: false }), RECENT_UPDATE_MS);
  recentUpdateTimer.unref?.();

  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
      detail: {
        ids: changed.map((order) => order.id),
        receiptNumbers: changed.map((order) => order.receipt_number).filter(Boolean),
        orders: changed,
      },
    }));
  }
}

/**
 * Backward backfill: the rest of history, newest page first, resuming from wherever a
 * previous attempt stopped. On a first setup (or a resumed partial one) `runSync()`
 * awaits this directly, since ADR 0019 keeps the gate up until it finishes; on an
 * already-initialized tablet there should be nothing left to backfill, but if there
 * ever is, it streams in behind the already-unlocked app instead.
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
 * ADR 0019's narrow foreground check: orders only, one bounded cursor stream, and no
 * reference-data work. It shares `inFlight` with login/reconnect sync so two cursor
 * owners never race. Failures reject for the app-wide scheduler to back off; every
 * successfully stored page remains durable and the next run resumes from its cursor.
 */
export async function pollOrderDelta() {
  if (inFlight) return { skipped: true, reason: 'in-flight' };

  const state = await getSyncState();
  if (isFirstSetupPending(state) || !state.orders_delta_cursor) {
    return { skipped: true, reason: 'setup-pending' };
  }

  inFlight = (async () => {
    publish({ orderCheck: 'checking' });
    try {
      const result = await syncOrderDelta(await getSyncState());
      await patchSyncState({ last_sync_completed_at: Date.now() });
      notifyOrdersChanged(result.orders);
      return { ran: true, ordersSynced: result.synced, orders: result.orders };
    } finally {
      publish({ orderCheck: 'idle' });
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

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

  // "Needs a full pull" (essentials only) and "the app gate is still pending" (ADR
  // 0019: essentials AND the complete order history) are different questions. A
  // resumed partial first setup already holds products/customers/personnel — it must
  // fetch those as a DELTA, not a second full pull — but the gate stays engaged until
  // its order-history backfill actually finishes.
  const needsEssentialsPull = !state.setup_complete;
  const gatePending = isFirstSetupPending(state);

  inFlight = (async () => {
    publish({
      phase: gatePending ? 'setup' : 'syncing',
      firstSetupPending: gatePending,
      essentialsReady: !needsEssentialsPull,
      error: null,
    });

    const result = { ran: true, firstSetup: needsEssentialsPull, entitiesSynced: [], ordersSynced: 0, error: null };

    try {
      // 1. Reference data. Per entity, so one failing endpoint cannot roll back the
      //    watermarks of the two that did land.
      const watermarks = { ...(state.reference_watermarks || {}) };
      for (const entity of REFERENCE_ENTITIES) {
        try {
          watermarks[entity] = await syncReferenceEntity(entity, needsEssentialsPull ? null : watermarks[entity]);
          result.entitiesSynced.push(entity);
        } catch (err) {
          result.error = err;
        }
      }
      await patchSyncState({ reference_watermarks: watermarks });

      // Essentials landing marks that a full reference pull never has to run again —
      // it does NOT clear the app gate by itself (ADR 0019). Anything short of every
      // entity landing must stay flagged as needing a full pull, or the next login
      // would run a delta against a tablet holding nothing.
      const essentialsLanded = REFERENCE_ENTITIES.every((e) => result.entitiesSynced.includes(e));
      if (needsEssentialsPull && essentialsLanded) await patchSyncState({ setup_complete: true });
      publish({ essentialsReady: essentialsLanded || !needsEssentialsPull });

      // 2. Order history. The forward delta first (cheap, and the part that matters
      //    for orders other tablets just created), then whatever backfill is still owed.
      try {
        const { synced, orders } = await syncOrderDelta(await getSyncState());
        result.ordersSynced += synced;
        notifyOrdersChanged(orders);
      } catch (err) {
        result.error = result.error || err;
      }

      const afterDelta = await getSyncState();
      if (!afterDelta.orders_backfill_complete) {
        if (gatePending) {
          // ADR 0019: "keep the app unavailable until the complete historical order
          // cache is downloaded." A first setup (or a resumed partial one) must not
          // let this stream in behind an unlocked app — that is exactly the shortcut
          // this gate exists to close — so the run genuinely waits on it here.
          await backfillOrderHistory();
        } else {
          // An already-initialized tablet: never re-gated, so any owed backfill (there
          // shouldn't normally be one) is free to stream in the background as before.
          const backfill = backfillOrderHistory();
          if (waitForOrders) await backfill;
        }
      }

      await patchSyncState({ last_sync_completed_at: Date.now() });

      // Re-read rather than assume: backfillOrderHistory() swallows its own errors, so
      // an interrupted first setup falls through to here with the gate still owed. The
      // published value is always the persisted truth, never an optimistic guess.
      const finalState = await getSyncState();
      publish({ firstSetupPending: isFirstSetupPending(finalState) });
      return result;
    } catch (err) {
      result.error = err;
      return result;
    } finally {
      // A first setup that could not finish leaves the gate exactly as the last
      // publish above left it (still pending) and simply goes idle — ADR 0019's
      // "waiting for connection" state — rather than either spinning forever or
      // falsely opening the app. The next login/reconnect/Retry resumes from here.
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
 * React view of the first-setup gate (ADR 0019): `blocking` is true for as long as this
 * device's first setup — reference data AND the complete order history — has never
 * fully finished, including a resume of one that was interrupted partway. `phase` lets
 * a screen tell "actively downloading" (`'setup'`) apart from "gated, but nothing is
 * running right now" (`'idle'` while still `blocking`) — a dropped connection or an
 * interrupted setup, which is the truthful "waiting for connection" state a Retry
 * action resumes from. Later login, reconnect and foreground syncs never reach
 * `blocking: true` once a device has finished its one first setup.
 */
export function useSyncGate() {
  const [state, setState] = useState(() => getSyncSnapshot());
  useEffect(() => subscribeSync(setState), []);
  return {
    blocking: state.firstSetupPending,
    phase: state.phase,
    essentialsReady: state.essentialsReady,
    ordersBackfilling: state.ordersBackfilling,
    ordersSynced: state.ordersSynced,
    error: state.error,
  };
}

// The header's one calm inbound/outbound status (ADR 0019). A routine successful empty
// check returns to idle; "Updated just now" is reserved for a delta that stored rows.
export function useSyncActivity() {
  const [state, setState] = useState(() => getSyncSnapshot());
  useEffect(() => subscribeSync(setState), []);
  return {
    checking: state.orderCheck === 'checking',
    recentlyUpdated: state.recentlyUpdated,
  };
}

// Test seams.
export const __SYNC_INTERNALS = { RECONNECT_THROTTLE_MS, ORDER_PAGE_SIZE };

export async function __resetSyncState() {
  inFlight = null;
  if (recentUpdateTimer) { clearTimeout(recentUpdateTimer); recentUpdateTimer = null; }
  snapshot = {
    phase: 'idle', firstSetupPending: false, essentialsReady: true,
    error: null, ordersBackfilling: false, ordersSynced: 0,
    orderCheck: 'idle', recentlyUpdated: false,
  };
  await nativeStore.remove(SYNC_STATE_KEY);
}
