// Device-issued receipt numbers (D1) — the shared parse/format rules.
//
// A receipt number is `<station>-<sequence>`, e.g. `1-00042`. The device issues it
// locally at Save, online or offline; the server never allocates one. It is stored
// decomposed on the row (`receipt_station`, `receipt_sequence`) so uniqueness can be
// expressed in SQL, and the display form is a GENERATED column (migration 033).
//
// The mirror of this module on the client is client/src/offline/receiptNumbers.js —
// keep the format in step across the two.

const SEQUENCE_PAD = 5;
const RECEIPT_NUMBER_RE = /^(\d{1,9})-(\d{1,9})$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// '1-00042' -> { station: 1, sequence: 42 }. Throws a 400-tagged error on anything
// else: a malformed key must never be silently dropped, or the resend protection it
// exists to provide silently disappears with it.
function parseReceiptNumber(value) {
  if (typeof value !== 'string') {
    throw badRequest('receipt_number must be a string of the form <station>-<sequence>');
  }
  const match = RECEIPT_NUMBER_RE.exec(value.trim());
  if (!match) {
    throw badRequest(`Malformed receipt_number '${value}' — expected <station>-<sequence>, e.g. 1-00042`);
  }
  const station = Number(match[1]);
  const sequence = Number(match[2]);
  if (station < 1 || sequence < 1) {
    throw badRequest(`Malformed receipt_number '${value}' — station and sequence both start at 1`);
  }
  return { station, sequence };
}

// 1, 42 -> '1-00042'. The sequence is zero-padded to 5; a device that ever runs past
// 99999 simply gets a longer number rather than a wrapped one.
function formatReceiptNumber(station, sequence) {
  return `${Number(station)}-${String(Number(sequence)).padStart(SEQUENCE_PAD, '0')}`;
}

module.exports = { parseReceiptNumber, formatReceiptNumber, SEQUENCE_PAD };
