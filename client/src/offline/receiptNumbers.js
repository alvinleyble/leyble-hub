// D1 — receipt numbers, the pure part.
//
// A receipt number is `<person><device letter>-<sequence>`, e.g. `1A-00042`
// (ADR 0017): the leading number identifies the person who sold it, the letter
// distinguishes that person's own devices, and the sequence counts within that pair.
//
// THREE SHAPES COEXIST PERMANENTLY and none of them is ever backfilled
// (ADR 0017 #12):
//   `#1240`    the ~1,300 legacy orders — no receipt number at all, shown as `#<id>`
//              by orderRef()
//   `3-00061`  the ADR 0016 slot scheme — a station number and no letter
//   `3A-00001` this scheme
// The letter is therefore OPTIONAL in every parser here, and stays optional forever:
// old-format acceptance is never removed (ADR 0014's ADR-0017 switchover ordering).
//
// Never sort or order by a receipt number — as text the three shapes sort as
// nonsense. Every list orders by time.
//
// Kept free of Capacitor and of the storage layer so display code and tests can import
// it anywhere. The server mirror is server/src/lib/receiptNumbers.js; keep the format
// in step across the two.

export const SEQUENCE_PAD = 5;

const RECEIPT_NUMBER_RE = /^(\d{1,9})([A-Za-z]{0,2})-(\d{1,9})$/;

// 1, 42, 'A' -> '1A-00042'; the letter is optional, so 1, 42 -> '1-00042' still.
export function formatReceiptNumber(station, sequence, device = null) {
  return `${Number(station)}${device ? String(device).toUpperCase() : ''}` +
    `-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

// '1A-00042' -> { station: 1, device: 'A', sequence: 42 }
// '1-00042'  -> { station: 1, device: null, sequence: 42 }
// null if it is not a receipt number.
export function parseReceiptNumber(value) {
  if (typeof value !== 'string') return null;
  const match = RECEIPT_NUMBER_RE.exec(value.trim());
  if (!match) return null;
  const station = Number(match[1]);
  const sequence = Number(match[3]);
  if (station < 1 || sequence < 1) return null;
  return { station, device: match[2] ? match[2].toUpperCase() : null, sequence };
}

// ── Delivery references (ADR 0015 §8, Slice 3.3; ADR 0017 #14) ──────────────
//
// `<person><device letter>-DEL-<sequence>`, e.g. `1A-DEL-00007`, and the pre-letter
// `1-DEL-00007` alongside it. Same shape and the same job as a receipt number — a
// device-issued identity, unique and stable (the resend key is separate since ADR 0017
// #9; see requestKeys.js) — with `DEL` in the middle so a delivery reference can never
// be mistaken for, or collide with, a customer's receipt number.
// The server mirror is server/src/lib/receiptNumbers.js.

const DELIVERY_REF_RE = /^(\d{1,9})([A-Za-z]{0,2})-DEL-(\d{1,9})$/i;

export function formatDeliveryRef(station, sequence, device = null) {
  return `${Number(station)}${device ? String(device).toUpperCase() : ''}` +
    `-DEL-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

export function parseDeliveryRef(value) {
  if (typeof value !== 'string') return null;
  const match = DELIVERY_REF_RE.exec(value.trim());
  if (!match) return null;
  const station = Number(match[1]);
  const sequence = Number(match[3]);
  if (station < 1 || sequence < 1) return null;
  return { station, device: match[2] ? match[2].toUpperCase() : null, sequence };
}
