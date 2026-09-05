import { V25_OFFLINE_CORE } from '../config/features';

// D1 — how an order is named to a human.
//
// The database row id stays an internal detail. Once a device issues receipt numbers,
// the app shows the receipt number everywhere it used to show `#<id>`: on screen, in
// toasts, on the paper. This is the single place that decision is expressed.
//
// Two things keep the switch-off behaviour identical to today. The release switch
// (D18) gates it, and an order that carries no receipt number falls back to `#<id>`
// anyway — which is also what the ~1,300 historical orders will always do, since D1
// accepts the one-time discontinuity and forbids backfilling them.
export function orderRef(order) {
  return orderRefWith(order, V25_OFFLINE_CORE);
}

// The decision itself, with the switch passed in — the switch is fixed at build time,
// so this is how both sides of it get tested.
export function orderRefWith(order, offlineCoreEnabled) {
  if (offlineCoreEnabled && order?.receipt_number) return order.receipt_number;
  // A draft is an unfinalized scratchpad, not a sale. The server deliberately leaves
  // its receipt_number NULL so no sequence number is burned on an order that may never
  // happen — which means falling through to `#<id>` here would put the internal row id
  // back on screen, the exact numbering ADR 0017 discontinued. Name it for what it is.
  //
  // A draft this device parked while blind is the one draft that DOES carry a number
  // (its own device-issued identity, and its anti-duplicate key), and it has no row id
  // at all, so that number is its name here regardless of the release switch.
  if (order?.status === 'draft') return order?.receipt_number || 'Draft';
  return `#${order?.id ?? ''}`;
}

// For the places that reference an order they do not hold — a ticket's related order, an
// activity log entry's entity_id, a review-queue tab that has not loaded its order yet.
// ADR 0010 wants those named by receipt number too, so the queries behind them now select
// the joined orders.receipt_number and pass it here; without one (a legacy order, or a row
// the join could not resolve) this falls back to '#<id>' as before.
export function orderRefFromId(id, receiptNumber) {
  return orderRef({ id, receipt_number: receiptNumber });
}
