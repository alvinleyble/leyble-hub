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
  return `#${order?.id ?? ''}`;
}

// For the places that hold only an id (a ticket's related order, an activity log
// entry's entity_id). There is no receipt number to show, so these keep naming the row.
export function orderRefFromId(id) {
  return `#${id ?? ''}`;
}
