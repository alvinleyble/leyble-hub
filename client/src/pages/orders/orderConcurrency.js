import { putOrderSnapshot } from '../../offline/receiptHistory.js';
import { orderRef } from '../../utils/orderRef.js';

const STATUS_LABEL = {
  draft: 'Draft',
  pending: 'Pending',
  in_transit: 'In Transit',
  completed: 'Delivered',
  done: 'Closed',
  cancelled: 'Cancelled',
};

export function isStaleOrderWrite(err) {
  return err?.status === 409 && err?.data?.code === 'stale_write' && err?.data?.order;
}

/**
 * Adopt the server's authoritative representation from a stale-write response. The
 * rejected intent is deliberately discarded: callers must never retry or merge it.
 */
export async function handleStaleOrderWrite(err, { addToast, onCurrent } = {}) {
  if (!isStaleOrderWrite(err)) return false;
  const current = err.data.order;
  await putOrderSnapshot(current).catch(() => {});
  onCurrent?.(current);
  const status = STATUS_LABEL[current.status] || current.status;
  addToast?.(
    `${orderRef(current)} changed on another device and is now ${status}. `
      + 'Your change was not saved. Review it and enter any change again.',
    'error'
  );
  return true;
}

/**
 * The matching row from a `leyble:orders-changed` delta that this screen has not yet
 * seen. `syncOrderDelta` re-delivers this device's OWN writes too (sync.js has no
 * self-origination filter) and every write path here already adopts the server's
 * response, so an id/receipt-number match alone is not news — the echo of a save
 * arrives at the revision the screen is already showing. `isNewerRevision` is what
 * separates the two, and it also drops a delta page fetched before a save that has
 * since landed, which must never be adopted backwards over the newer value.
 */
export function orderChangedInEvent(order, detail) {
  if (!order || !detail) return null;
  const changed = Array.isArray(detail.orders) ? detail.orders : [];
  const match = changed.find((candidate) =>
    String(candidate.id) === String(order.id)
      || (order.receipt_number && candidate.receipt_number === order.receipt_number)
  ) || null;
  return match && isNewerRevision(order, match) ? match : null;
}

/**
 * `orders.revision` is a `BIGINT` (migration 048) and pg hands it over as a string, so
 * it is compared as a BigInt and never as a Number — past 2^53 a Number silently loses
 * the low digits and two different revisions start comparing equal. `null` is returned
 * for anything that cannot be ordered as an integer, which each predicate below then
 * biases its own way.
 */
function comparableRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return BigInt(String(value).trim());
  } catch {
    return null;
  }
}

/**
 * ADR 0019 — a revision only ever counts forward (migration 048's BEFORE UPDATE
 * trigger), so "newer" means strictly greater. An echo carrying a revision a screen
 * already holds is not a change it has yet to see — most often it is this device's
 * own write coming back round, which must never be dressed up as another device's.
 *
 * Either side missing a usable revision (a pre-048 server, a local snapshot that
 * predates the column) is unorderable, and the safe answer there is "newer": warning
 * about a change that turns out to be our own is recoverable, silently swallowing a
 * real one is not.
 */
export function isNewerRevision(held, incoming) {
  const heldRevision = comparableRevision(held?.revision);
  const incomingRevision = comparableRevision(incoming?.revision);
  if (heldRevision === null || incomingRevision === null) return true;
  return incomingRevision > heldRevision;
}

/**
 * The narrower question a drained write can ask: is this row the single write I made,
 * and nothing else? Migration 048's trigger advances the revision by exactly one per
 * UPDATE, and POST /orders/:id/receipt-printed is one UPDATE, so a drained print that
 * lands on `held.revision + 1` is the only change between the two — safe to adopt
 * silently. Anything further ahead means somebody else's write landed in the same
 * window, and that row belongs on the ordinary "changed on another device" path.
 *
 * An unorderable pair answers false: "I cannot prove this is only my own write" is the
 * side that keeps the warning, matching `isNewerRevision`'s bias in the opposite
 * direction.
 */
export function isOneRevisionAhead(held, incoming) {
  const heldRevision = comparableRevision(held?.revision);
  const incomingRevision = comparableRevision(incoming?.revision);
  if (heldRevision === null || incomingRevision === null) return false;
  return incomingRevision === heldRevision + 1n;
}

export function orderStatusLabel(status) {
  return STATUS_LABEL[status] || status;
}
