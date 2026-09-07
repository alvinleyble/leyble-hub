import { orderRef } from './orderRef';

// Slice 3.2 — the offline Outgoing Orders directory.
//
// When the server cannot be reached, OrdersPage serves the table from this device's
// own synced order history (offline/receiptHistory.js) instead of showing an empty
// list and an error toast. That history is the WHOLE history, not just what this
// tablet created, so the filters the operator is already using have to keep working
// against it — a directory you cannot filter is barely a directory.
//
// Pure and separate from the page so the matching rules are testable on their own and
// stay identical to the server's: same status tabs, same inclusive from/to dates, same
// receipt-number-or-customer search, and drafts hidden everywhere except their own tab.

const startOfDay = (value) => {
  const at = new Date(`${value}T00:00:00`);
  return Number.isNaN(at.getTime()) ? null : at.getTime();
};

const endOfDay = (value) => {
  const at = startOfDay(value);
  return at === null ? null : at + 24 * 60 * 60 * 1000 - 1;
};

export function localOrderMatches(order, { statusTab = 'all', fromDate = '', toDate = '', search = '' } = {}) {
  if (!order) return false;

  if (statusTab === 'all') {
    // Matches the server's default: a parked draft is working state, not history.
    if (order.status === 'draft') return false;
  } else if (order.status !== statusTab) {
    return false;
  }

  if (fromDate || toDate) {
    const at = Date.parse(order.created_at);
    if (!Number.isFinite(at)) return false;
    const from = fromDate ? startOfDay(fromDate) : null;
    const to   = toDate ? endOfDay(toDate) : null;
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    const qClean = q.replace(/^#/, '');
    const matches =
      String(order.customer_name || '').toLowerCase().includes(q) ||
      String(order.id || '').toLowerCase().includes(qClean) ||
      String(order.receipt_number || '').toLowerCase().includes(q) ||
      orderRef(order).toLowerCase().includes(q);
    if (!matches) return false;
  }

  return true;
}

/** Newest first, matching the server's `ORDER BY created_at DESC`. */
export function filterLocalHistory(orders, filters = {}) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => localOrderMatches(o, filters))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

/**
 * The route segment that reaches an order's detail page from a local snapshot.
 *
 * Receipt number first: it is the identity that survives the sync boundary (ADR 0010),
 * and a still-local order has no row id at all yet. The row id is the fallback for
 * every pre-V2.5 order, which has no receipt number and never will —
 * `getReceipt()` resolves both (ADR 0015 §4).
 */
export function localOrderRoute(order) {
  return order?.receipt_number || order?.id;
}
