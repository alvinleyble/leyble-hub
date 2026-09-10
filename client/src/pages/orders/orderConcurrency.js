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

export function orderStatusLabel(status) {
  return STATUS_LABEL[status] || status;
}
