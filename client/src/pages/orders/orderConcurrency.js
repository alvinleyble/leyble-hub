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
 * True only when `candidate` is a strictly NEWER revision of the order this screen
 * already holds. The forward delta re-delivers this device's own writes (sync.js has
 * no self-origination filter), and every write path here already adopts the server's
 * response, so the echo normally arrives at the revision the screen is showing. That
 * is not a change on another device and must never be reported as one. An echo at an
 * OLDER revision (a delta page fetched before a save that has since landed) is stale
 * and is likewise ignored rather than shown or adopted backwards.
 */
export function isNewerRevision(candidate, order) {
  const next = candidate?.revision;
  const held = order?.revision;
  // A locally-created order has no revision yet; anything the server sends is news.
  if (next === undefined || next === null || held === undefined || held === null) return true;
  try {
    return BigInt(String(next)) > BigInt(String(held));
  } catch {
    return String(next) !== String(held);
  }
}

export function orderChangedInEvent(order, detail) {
  if (!order || !detail) return null;
  const changed = Array.isArray(detail.orders) ? detail.orders : [];
  const match = changed.find((candidate) =>
    String(candidate.id) === String(order.id)
      || (order.receipt_number && candidate.receipt_number === order.receipt_number)
  ) || null;
  return match && isNewerRevision(match, order) ? match : null;
}

export function orderStatusLabel(status) {
  return STATUS_LABEL[status] || status;
}
