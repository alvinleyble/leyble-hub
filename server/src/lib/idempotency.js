// The anti-duplicate key for a resent record.
//
// A queued record can be sent more than once: a POST that commits on the server and
// then times out on the way back is retried by the outbox, and without this the
// retry becomes a second order. The device sends a key with every queued record, and
// the server treats that key as the record's identity — a second arrival of a key
// already stored is answered as SUCCESS, so the device clears it from the outbox and
// stops retrying.
//
// ── Which key (ADR 0017 #9, revising ADR 0006) ──────────────────────────────
//
// That key is `request_key`: generated on the device once per outbox record and
// resent unchanged on every retry OF THAT RECORD. It labels the *attempt to send a
// sale*; the receipt number labels the *sale*.
//
// It used to be the receipt number itself (ADR 0006 Option A). Coupling the two made
// a duplicated receipt number silently destructive — the second sale was answered
// with the FIRST sale's stored order, the device cleared its outbox, and the sale
// vanished with nothing reporting it. Keyed on `request_key` instead, two genuinely
// different sales are two rows even if they collide on a receipt number, and the
// collision surfaces as a refusal a human can act on rather than as data loss.
//
// The receipt-number path below is NOT dead code and must not be removed. It is the
// fallback for a record that carries no `request_key`: an outbox record queued by a
// pre-039 build and still waiting to drain, which is exactly the multi-day
// mixed-fleet window ADR 0014's switchover ordering is about.
//
// ── Table-agnostic by design ────────────────────────────────────────────────
//
// Any table that carries `request_key` (and, for the fallback, the
// `receipt_station` / `receipt_sequence` pair) with the matching partial unique
// indexes can use this: `orders` (receipts and parked orders alike, since a parked
// order is an orders row) and, since ADR 0015 §8 / migration 036,
// `supplier_deliveries`. Adding a table here is the whole integration.

// Whitelist, because the table name is interpolated into SQL. Never take this from
// a request body.
const RECEIPT_TABLES = new Set(['orders', 'supplier_deliveries']);

const UNIQUE_VIOLATION = '23505';

// Long enough for a UUID with room to spare, short enough that a client cannot use
// the column as free storage. Matches VARCHAR(64) in migration 039.
const REQUEST_KEY_MAX_LENGTH = 64;
const REQUEST_KEY_RE = /^[A-Za-z0-9_.:-]+$/;

function assertIdempotentTable(table) {
  if (!RECEIPT_TABLES.has(table)) {
    throw new Error(`Table '${table}' does not carry the device-issued identity columns`);
  }
}

/**
 * Normalises an incoming `request_key`.
 *
 * Returns null when the field is simply absent — a request from a connected client,
 * or from a pre-039 outbox record, and both behave exactly as they did before.
 * Throws a 400 for a key that is present but unusable, for the same reason a
 * malformed receipt number is refused: silently ignoring the key would silently
 * remove the protection it exists to provide.
 */
function normalizeRequestKey(value, { field = 'request_key' } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > REQUEST_KEY_MAX_LENGTH || !REQUEST_KEY_RE.test(key)) {
    const err = new Error(`Malformed ${field}`);
    err.status = 400;
    throw err;
  }
  return key;
}

// Returns the existing row's id, or null. Called before the insert (the common case:
// the first attempt reached the database, only the response was lost).
async function findByRequestKey(runner, table, requestKey) {
  assertIdempotentTable(table);
  const { rows: [row] } = await runner.query(
    `SELECT id FROM ${table} WHERE request_key = $1`,
    [requestKey]
  );
  return row ? row.id : null;
}

// Fallback identity for a record queued before request keys existed. See the header.
async function findByReceiptNumber(runner, table, { station, sequence }) {
  assertIdempotentTable(table);
  const { rows: [row] } = await runner.query(
    `SELECT id FROM ${table} WHERE receipt_station = $1 AND receipt_sequence = $2`,
    [station, sequence]
  );
  return row ? row.id : null;
}

// The pre-flight lookups above close the ordinary case but not the race where two
// drain attempts overlap: both look, neither finds, both insert. The partial unique
// index catches the loser, and this recognises its error so the loser can be answered
// as a success too.
function isUniqueViolation(err, indexName) {
  return err?.code === UNIQUE_VIOLATION && err?.constraint === indexName;
}

const isDuplicateRequestKey = isUniqueViolation;
const isDuplicateReceiptNumber = isUniqueViolation;

module.exports = {
  normalizeRequestKey,
  findByRequestKey,
  findByReceiptNumber,
  isDuplicateRequestKey,
  isDuplicateReceiptNumber,
  isUniqueViolation,
  RECEIPT_TABLES,
  REQUEST_KEY_MAX_LENGTH,
};
