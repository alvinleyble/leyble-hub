// D13 — the receipt number is also the anti-duplicate key.
//
// A queued record can be sent more than once: a POST that commits on the server and
// then times out on the way back is retried by the outbox, and without this the
// retry becomes a second order. The device sends the receipt number it issued with
// every queued record, and the server treats that number as the record's identity —
// a second arrival of a number already stored is answered as SUCCESS, so the device
// clears it from the outbox and stops retrying.
//
// The mechanism is deliberately table-agnostic. Any table that carries the
// `receipt_station` / `receipt_sequence` pair and the matching partial unique index
// can use it: `orders` today (receipts and parked orders alike, since a parked order
// is an orders row), `supplier_deliveries` when Release 2 adds offline incoming
// deliveries. Adding a table here is the whole integration.

// Whitelist, because the table name is interpolated into SQL. Never take this from
// a request body.
const RECEIPT_TABLES = new Set(['orders']);

const UNIQUE_VIOLATION = '23505';

function assertReceiptTable(table) {
  if (!RECEIPT_TABLES.has(table)) {
    throw new Error(`Table '${table}' does not carry a device-issued receipt number`);
  }
}

// Returns the existing row's id, or null. Called before the insert (the common case:
// the first attempt reached the database, only the response was lost).
async function findByReceiptNumber(runner, table, { station, sequence }) {
  assertReceiptTable(table);
  const { rows: [row] } = await runner.query(
    `SELECT id FROM ${table} WHERE receipt_station = $1 AND receipt_sequence = $2`,
    [station, sequence]
  );
  return row ? row.id : null;
}

// The pre-flight lookup above closes the ordinary case but not the race where two
// drain attempts overlap: both look, neither finds, both insert. The partial unique
// index catches the loser, and this recognises its error so the loser can be answered
// as a success too.
function isDuplicateReceiptNumber(err, indexName) {
  return err?.code === UNIQUE_VIOLATION && err?.constraint === indexName;
}

module.exports = { findByReceiptNumber, isDuplicateReceiptNumber, RECEIPT_TABLES };
