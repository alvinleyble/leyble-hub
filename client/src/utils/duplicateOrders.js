// D6 — the accepted double-print risk, surfaced.
//
// Tablet A parks an order, Tablet B resumes and prints it, the line drops while A
// still holds a stale copy, A prints it again: one order, two receipts, two device-
// issued numbers. No guard is built (the captain accepted the risk); instead, once
// both copies reach the server, they are flagged as a possible double using the
// exact composite-key shape duplicateCustomers.js already established for D4 — same
// pattern, no new idea for the owners to learn.
//
// The order list endpoint (GET /orders) does not join line items, so the signature
// is built from what it does return: the same customer, channel and goods total,
// both still pending and both carrying a device-issued receipt number. Two
// independently local-first-saved copies of the same parked draft share all of
// these, since both were built from the same cart.

function compositeKey(order) {
  if (!order || !order.customer_id || !order.receipt_number || order.status !== 'pending') return null;
  const total = Number(order.total_amount) || 0;
  const adjustment = Number(order.adjustment) || 0;
  return `${order.customer_id}:::${order.order_type || 'delivery'}:::${total}:::${adjustment}`;
}

/**
 * Finds groups of possibly-doubled orders (D6).
 *
 * @param {Array<object>} orders
 * @returns {Record<string, Array<object>>} compositeKey -> orders sharing it (length >= 2)
 */
export function findPossibleDoubleGroups(orders = []) {
  const groups = {};
  for (const order of orders) {
    const key = compositeKey(order);
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(order);
  }

  const doubles = {};
  for (const [key, group] of Object.entries(groups)) {
    // Distinct receipt numbers only — the same order returned twice by a paginated
    // fetch is not a double.
    const distinct = new Set(group.map((o) => o.receipt_number));
    if (distinct.size > 1) doubles[key] = group;
  }
  return doubles;
}

export function getPossibleDoubleOrderIds(orders = []) {
  const groups = findPossibleDoubleGroups(orders);
  const ids = new Set();
  for (const group of Object.values(groups)) {
    for (const o of group) ids.add(o.id);
  }
  return ids;
}

export function countPossibleDoubleOrders(orders = []) {
  return getPossibleDoubleOrderIds(orders).size;
}
