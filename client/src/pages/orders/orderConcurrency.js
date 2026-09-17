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

export function orderChangedInEvent(order, detail) {
  if (!order || !detail) return null;
  const changed = Array.isArray(detail.orders) ? detail.orders : [];
  return changed.find((candidate) =>
    String(candidate.id) === String(order.id)
      || (order.receipt_number && candidate.receipt_number === order.receipt_number)
  ) || null;
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
  const heldRevision = Number(held?.revision);
  const incomingRevision = Number(incoming?.revision);
  if (!Number.isFinite(heldRevision) || !Number.isFinite(incomingRevision)) return true;
  return incomingRevision > heldRevision;
}

export function orderStatusLabel(status) {
  return STATUS_LABEL[status] || status;
}
