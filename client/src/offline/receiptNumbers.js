// D1 — receipt numbers, the pure part.
//
// Kept free of Capacitor and of the storage layer so display code and tests can import
// it anywhere. The server mirror is server/src/lib/receiptNumbers.js; keep the format
// in step across the two.

export const SEQUENCE_PAD = 5;

const RECEIPT_NUMBER_RE = /^(\d{1,9})-(\d{1,9})$/;

// 1, 42 -> '1-00042'
export function formatReceiptNumber(station, sequence) {
  return `${Number(station)}-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

// '1-00042' -> { station: 1, sequence: 42 }, or null if it is not a receipt number.
export function parseReceiptNumber(value) {
  if (typeof value !== 'string') return null;
  const match = RECEIPT_NUMBER_RE.exec(value.trim());
  if (!match) return null;
  const station = Number(match[1]);
  const sequence = Number(match[2]);
  if (station < 1 || sequence < 1) return null;
  return { station, sequence };
}

// ── Delivery references (ADR 0015 §8, Slice 3.3) ────────────────────────────
//
// `<station>-DEL-<sequence>`, e.g. `1-DEL-00007`. Same shape and the same job as a
// receipt number — a device-issued identity that doubles as the anti-duplicate key
// for a resent outbox record (ADR 0006) — with `DEL` in the middle so a delivery
// reference can never be mistaken for, or collide with, a customer's receipt number.
// The server mirror is server/src/lib/receiptNumbers.js.

const DELIVERY_REF_RE = /^(\d{1,9})-DEL-(\d{1,9})$/i;

export function formatDeliveryRef(station, sequence) {
  return `${Number(station)}-DEL-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

export function parseDeliveryRef(value) {
  if (typeof value !== 'string') return null;
  const match = DELIVERY_REF_RE.exec(value.trim());
  if (!match) return null;
  const station = Number(match[1]);
  const sequence = Number(match[2]);
  if (station < 1 || sequence < 1) return null;
  return { station, sequence };
}
