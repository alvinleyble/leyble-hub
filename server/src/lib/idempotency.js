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
// `receipt_station` / `receipt_device` / `receipt_sequence` triple) with the matching
// partial unique indexes can use this: `orders` (receipts and parked orders alike,
// since a parked order is an orders row) and, since ADR 0015 §8 / migration 036,
// `supplier_deliveries`. Adding a table here is the whole integration.

// ── Creates vs. mutations ───────────────────────────────────────────────────
//
// Everything above stores the key ON the row the request created, which is only
// possible because a create's result is a new row. An UPDATE has none: the order
// already exists and is edited many times, so `claimRequestKey` below stores the key
// in `request_keys` (migration 050) alongside the entity it was spent on.
//
// It is the same mechanism, not a second one — the same device-minted key, the same
// `normalizeRequestKey`, the same "a conflict means this already happened, answer with
// what is stored" rule. Only the storage site differs, and only because an update has
// no row of its own to carry it.

// Whitelist, because the table name is interpolated into SQL. Never take this from
// a request body.
const RECEIPT_TABLES = new Set(['orders', 'supplier_deliveries']);

// The same idea for `request_keys.entity_type`: a closed set, never a request field.
// `order` is the only member today; a second entity is one entry here plus the claim
// call in its route.
const MUTATION_ENTITIES = new Set(['order']);

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
//
// The device letter (ADR 0017) is matched through the same COALESCE the partial unique
// index uses, so this lookup and the index agree exactly: a pre-letter `3-00061`
// carries a NULL letter and must still find its own stored row, while `3A-00061` is a
// different receipt belonging to a different device. A pre-039 record — the only kind
// that reaches this path — never carries a letter, so it resolves against the
// letterless rows and nothing else.
async function findByReceiptNumber(runner, table, { station, device = null, sequence }) {
  assertIdempotentTable(table);
  const { rows: [row] } = await runner.query(
    `SELECT id FROM ${table}
      WHERE receipt_station = $1
        AND COALESCE(receipt_device, '') = $2
        AND receipt_sequence = $3`,
    [station, device || '', sequence]
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

/**
 * Claims `key` for one mutation of one entity, inside the caller's transaction.
 *
 * Returns `{ claimed: true }` the first time a key is seen: the caller owns this
 * attempt and goes on to do the work. The claim lives in the same transaction as that
 * work, so a rolled-back write releases its key and a committed one keeps it — the key
 * is spent exactly when the write it guards is.
 *
 * Returns `{ claimed: false, entityType, entityId }` when the key is already stored,
 * which means this exact attempt already ran to completion. The caller must NOT repeat
 * the work; it answers with the entity as stored. `entityId` is returned rather than
 * assumed so a key replayed against a different entity is recognisable as misuse
 * instead of being answered with some other order's data.
 *
 * `ON CONFLICT DO NOTHING` rather than a look-then-insert: it is one round trip on the
 * common path (round trips are the budget here — see CLAUDE.md), and it waits on a
 * concurrent claim of the same key rather than racing it, which is what makes two
 * overlapping retries of one aborted save resolve to a single write.
 */
async function claimRequestKey(runner, { key, entityType, entityId }) {
  if (!MUTATION_ENTITIES.has(entityType)) {
    throw new Error(`Entity '${entityType}' is not covered by request-key idempotency`);
  }
  const { rowCount } = await runner.query(
    `INSERT INTO request_keys (request_key, entity_type, entity_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (request_key) DO NOTHING`,
    [key, entityType, entityId]
  );
  if (rowCount === 1) return { claimed: true, entityType, entityId };

  // A separate statement, so it reads a fresh snapshot and therefore sees the row that
  // caused the conflict even when that row was committed by another transaction while
  // the INSERT above was waiting on it.
  const { rows: [prior] } = await runner.query(
    'SELECT entity_type, entity_id FROM request_keys WHERE request_key = $1',
    [key]
  );
  return {
    claimed: false,
    entityType: prior ? prior.entity_type : null,
    entityId: prior ? Number(prior.entity_id) : null,
  };
}

module.exports = {
  normalizeRequestKey,
  claimRequestKey,
  findByRequestKey,
  findByReceiptNumber,
  isDuplicateRequestKey,
  isDuplicateReceiptNumber,
  isUniqueViolation,
  RECEIPT_TABLES,
  MUTATION_ENTITIES,
  REQUEST_KEY_MAX_LENGTH,
};
