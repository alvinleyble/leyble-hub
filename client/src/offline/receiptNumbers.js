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
