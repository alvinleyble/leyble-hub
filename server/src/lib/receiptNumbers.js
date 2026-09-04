// Device-issued receipt numbers (D1) — the shared parse/format rules.
//
// A receipt number is `<person><device letter>-<sequence>`, e.g. `1A-00042`
// (ADR 0017): the leading number identifies the person who sold it, the letter
// distinguishes that person's own devices, and the sequence counts within that pair.
// The device issues the whole thing locally at Save, online or offline; the server
// never allocates one. It is stored decomposed on the row (`receipt_station`,
// `receipt_device`, `receipt_sequence`) so uniqueness can be expressed in SQL, and
// the display form is a GENERATED column (migrations 033 and 040).
//
// THREE SHAPES COEXIST PERMANENTLY and none of them is ever backfilled
// (ADR 0017 #12):
//   `#1240`    the ~1,300 legacy orders — no receipt number at all, addressed by row
//              id, which is why resolveOrderId in routes/orders.js still takes digits
//   `3-00061`  the pre-letter scheme (ADR 0016's now-removed slots) — no letter
//   `3A-00001` this scheme
// The letter is therefore OPTIONAL here, and stays optional forever: old-format
// acceptance is never removed (ADR 0014's ADR-0017 switchover ordering, step 4).
//
// Never sort or order by a receipt number — as text the three shapes sort as
// nonsense. Every list, export and report orders by time.
//
// The mirror of this module on the client is client/src/offline/receiptNumbers.js —
// keep the format in step across the two.

const SEQUENCE_PAD = 5;
const RECEIPT_NUMBER_RE = /^(\d{1,9})([A-Za-z]{0,2})-(\d{1,9})$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// '1A-00042' -> { station: 1, device: 'A', sequence: 42 }
// '1-00042'  -> { station: 1, device: null, sequence: 42 }
//
// Throws a 400-tagged error on anything else: a malformed key must never be silently
// dropped, or the resend protection it exists to provide silently disappears with it.
function parseReceiptNumber(value) {
  if (typeof value !== 'string') {
    throw badRequest('receipt_number must be a string of the form <person><device letter>-<sequence>');
  }
  const match = RECEIPT_NUMBER_RE.exec(value.trim());
  if (!match) {
    throw badRequest(`Malformed receipt_number '${value}' — expected <person><device letter>-<sequence>, e.g. 1A-00042`);
  }
  const station = Number(match[1]);
  const sequence = Number(match[3]);
  if (station < 1 || sequence < 1) {
    throw badRequest(`Malformed receipt_number '${value}' — person and sequence both start at 1`);
  }
  return { station, device: match[2] ? match[2].toUpperCase() : null, sequence };
}

// 1, 42, 'A' -> '1A-00042'; the letter is optional, so 1, 42 -> '1-00042' still.
// The sequence is zero-padded to 5; a device that ever runs past 99999 simply gets a
// longer number rather than a wrapped one.
function formatReceiptNumber(station, sequence, device = null) {
  return `${Number(station)}${device ? String(device).toUpperCase() : ''}` +
    `-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

// ── Delivery references (ADR 0015 §8, ADR 0017 #14) ─────────────────────────
//
// `<person><device letter>-DEL-<sequence>`, e.g. `1A-DEL-00007`, and the pre-letter
// `1-DEL-00007` alongside it. Same role as a receipt number — a device-issued identity,
// unique and stable (the resend key is separate since ADR 0017 #9; see
// lib/idempotency.js) — stored in the same decomposed columns on supplier_deliveries
// (migrations 036 and 040).
// The `DEL` infix keeps the two series from ever being read as one another.

const DELIVERY_REF_RE = /^(\d{1,9})([A-Za-z]{0,2})-DEL-(\d{1,9})$/i;

function parseDeliveryRef(value) {
  if (typeof value !== 'string') {
    throw badRequest('delivery_ref must be a string of the form <person><device letter>-DEL-<sequence>');
  }
  const match = DELIVERY_REF_RE.exec(value.trim());
  if (!match) {
    throw badRequest(`Malformed delivery_ref '${value}' — expected <person><device letter>-DEL-<sequence>, e.g. 1A-DEL-00007`);
  }
  const station = Number(match[1]);
  const sequence = Number(match[3]);
  if (station < 1 || sequence < 1) {
    throw badRequest(`Malformed delivery_ref '${value}' — person and sequence both start at 1`);
  }
  return { station, device: match[2] ? match[2].toUpperCase() : null, sequence };
}

function formatDeliveryRef(station, sequence, device = null) {
  return `${Number(station)}${device ? String(device).toUpperCase() : ''}` +
    `-DEL-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}


// ── Bare-digit lookup (ADR 0017 #11) ────────────────────────────────────────
//
// A customer reads the digits off faded thermal paper and skips the prefix. `42` has to
// find every order whose SEQUENCE is 42, whichever prefix issued it — `1A-00042`,
// `2B-00042` and the pre-letter `3-00042` alike — and the answer is a short
// disambiguation list, never a jump straight to one order.
//
// Leading zeros are the same number, so `00042` and `42` are one term. `#1240` is bare
// digits too once the hash is stripped, which is exactly right: for the ~1,300 legacy
// orders the digits ARE the row id, so the search has to look in both places.
//
// Unlike parseReceiptNumber above this NEVER throws — a search term that is not digits
// is an ordinary text search, not a malformed key. Returns null in that case.
function parseBareSequence(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

module.exports = {
  parseReceiptNumber, formatReceiptNumber, parseDeliveryRef, formatDeliveryRef,
  parseBareSequence, SEQUENCE_PAD,
};
