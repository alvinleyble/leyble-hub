import { nativeStore } from './nativeStore';
import {
  RECEIPT_PREFIX, receiptKey,
  ORDER_INDEX_PREFIX, orderIndexKey, snapshotIdentifier,
} from './keys';

// The device's own copy of order history — what makes History, reprint and the whole
// Outgoing Orders directory work while blind.
//
// One key per order (see nativeStore.js on why): a day's trading rewrites only that
// day's orders, and an interrupted write can cost at most one record.
//
// ADR 0015 §4 supersedes V2.5 D9's rolling 30-day window: snapshots are kept with NO
// AGE LIMIT. The owners look up months-old invoices and long-running bottle-deposit
// balances from the counter, and a 30-day cap turned exactly those lookups into
// "Order not found" during an outage. `pruneReceipts` below is kept for explicit,
// deliberate use (and for the tests that pin its behaviour) but nothing calls it on
// its own any more — see offline/index.js.

export const RETENTION_DAYS = 30;

export async function putReceipt(receipt) {
  if (!receipt?.receipt_number) {
    throw new Error('putReceipt: a locally held receipt needs its receipt_number');
  }
  await nativeStore.setJson(receiptKey(receipt.receipt_number), receipt);
  await indexOrder(receipt);
}

/**
 * Stores a full order snapshot pulled from the server (sync.js), which — unlike a
 * locally saved sale — may have no receipt number at all: every order created before
 * V2.5 has only a row id, and those are never backfilled (ADR 0010).
 *
 * ADR 0015 §4: the snapshot must be COMPLETE. A summary row (no `items`) is what used
 * to crash OrderDetailPage on open, so an order arriving without an items array is
 * stored with an empty one rather than an absent one, and the page's own guards read
 * that as "nothing to show" instead of throwing.
 */
export async function putOrderSnapshot(order) {
  const identifier = snapshotIdentifier(order);
  if (!identifier) return null;
  const snapshot = {
    ...order,
    items: Array.isArray(order.items) ? order.items : [],
    personnel: Array.isArray(order.personnel) ? order.personnel : [],
  };
  await nativeStore.setJson(receiptKey(identifier), snapshot);
  await indexOrder(snapshot);
  return identifier;
}

// Point the numeric row id at whichever key the snapshot actually lives under.
async function indexOrder(order) {
  const identifier = snapshotIdentifier(order);
  if (!identifier) return;
  if (order?.id === undefined || order?.id === null) return;
  if (String(order.id).startsWith('local-')) return;
  await nativeStore.setString(orderIndexKey(order.id), identifier);
}

/**
 * ADR 0015 §4 — Dual Identifier Resolution. Resolves either a device-issued receipt
 * number (`1-00042`) or a PostgreSQL row id (`1240`), so a link from an audit entry,
 * a ticket, or a bookmarked URL never dead-ends offline.
 *
 * Order of attempts, cheapest first:
 *   1. the identifier as a key outright (the overwhelmingly common receipt-number case)
 *   2. `id-<identifier>` (an order the server gave us that has no receipt number)
 *   3. the id → identifier index written above
 *   4. a scan of stored snapshots, matching on `id` — the index is a convenience, so a
 *      missing index entry must never be the reason a held order cannot be opened.
 */
export async function getReceipt(identifier) {
  if (identifier === undefined || identifier === null || identifier === '') return null;
  const key = String(identifier);

  const direct = await nativeStore.getJson(receiptKey(key));
  if (direct) return direct;

  const byRowKey = await nativeStore.getJson(receiptKey(`id-${key}`));
  if (byRowKey) return byRowKey;

  const indexed = await nativeStore.getString(orderIndexKey(key));
  if (indexed) {
    const viaIndex = await nativeStore.getJson(receiptKey(indexed));
    if (viaIndex) return viaIndex;
  }

  const all = await listReceipts();
  return all.find((r) => String(r.id) === key) || null;
}

// Reading the whole history is one native bridge call PER KEY, and the store's real
// history is on the order of two thousand orders (measured on the dev database: 1769
// orders, ~2.5 MB). Strictly sequential reads make the offline Outgoing Orders list
// wait out two thousand round trips; reading in waves turns that into a few dozen.
// Deliberately not "all at once" — an unbounded Promise.all over every key is how a
// mid-range Android tablet ends up thrashing.
const READ_BATCH = 50;

// Newest first, matching how History and the orders list read.
export async function listReceipts() {
  const keys = await nativeStore.keysWithPrefix(RECEIPT_PREFIX);
  const receipts = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const batch = await Promise.all(keys.slice(i, i + READ_BATCH).map((k) => nativeStore.getJson(k)));
    for (const receipt of batch) if (receipt) receipts.push(receipt);
  }
  return receipts.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export async function countReceipts() {
  return (await nativeStore.keysWithPrefix(RECEIPT_PREFIX)).length;
}

export async function removeReceipt(receiptNumber) {
  const snapshot = await nativeStore.getJson(receiptKey(receiptNumber));
  await nativeStore.remove(receiptKey(receiptNumber));
  if (snapshot?.id !== undefined && snapshot?.id !== null) {
    await nativeStore.remove(orderIndexKey(snapshot.id));
  }
}

/**
 * Drop snapshots older than a window. NOTHING calls this automatically any more
 * (ADR 0015 §4 removed the age limit); it stays as an explicit tool.
 *
 * `created_at` is the device's sale time (D5), which is what the owners would call the
 * receipt's date — so the window matches the paper. A receipt with no usable date is
 * KEPT: dropping a record because its date is unreadable is the silent loss this
 * release exists to prevent.
 */
export async function pruneReceipts({ now = Date.now(), days = RETENTION_DAYS } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const receipts = await listReceipts();
  let pruned = 0;
  for (const receipt of receipts) {
    const at = Date.parse(receipt.created_at);
    if (Number.isFinite(at) && at < cutoff) {
      await removeReceipt(snapshotIdentifier(receipt));
      pruned++;
    }
  }
  return pruned;
}

// Test seam — clears held snapshots and their id index.
export async function __clearReceipts() {
  for (const key of await nativeStore.keysWithPrefix(RECEIPT_PREFIX)) await nativeStore.remove(key);
  for (const key of await nativeStore.keysWithPrefix(ORDER_INDEX_PREFIX)) await nativeStore.remove(key);
}
