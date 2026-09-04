import { parseBareSequence } from '../offline/receiptNumbers';
import { orderRef } from './orderRef';

// ADR 0017 #11 — how a half-remembered number finds its order.
//
// The list's instant client-side filter has to agree with what the server's `search`
// parameter does (GET /orders in server/src/routes/orders.js), or the same term shows
// one set of rows before the request lands and another after.
//
// BARE DIGITS ARE A SEQUENCE, not a substring. Customers read the digits off faded
// thermal paper and skip the prefix, so `42` returns every order whose sequence is 42
// — `1A-00042`, `2B-00042`, the pre-letter `3-00042` — as a short disambiguation list
// with the customer's name and the date, never a jump straight to one order. The
// number of parallel series only grows over time, so this has to stay a list.
//
// A substring match cannot say that: `%42%` also drags in `3-00420` and `1-00142`.
// The row id stays in the OR because for the ~1,300 legacy orders the digits ARE the
// id — they carry no sequence and are never backfilled (ADR 0017 #12).
//
// Anything that is not purely digits (a full receipt number, a customer's name) falls
// through to the ordinary case-insensitive substring match, unchanged.
export function orderMatchesSearch(order, rawTerm) {
  const term = String(rawTerm || '').trim();
  if (!term) return true;

  const sequence = parseBareSequence(term);
  if (sequence !== null) {
    return Number(order?.receipt_sequence) === sequence || Number(order?.id) === sequence;
  }

  const q = term.toLowerCase();
  return (
    (order?.customer_name || '').toLowerCase().includes(q) ||
    String(order?.receipt_number || '').toLowerCase().includes(q) ||
    orderRef(order).toLowerCase().includes(q)
  );
}
