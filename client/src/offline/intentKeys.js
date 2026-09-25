// The retry key on a MUTATION of an order that already exists — the client half of
// migration 050.
//
// The problem it closes is in api/client.js itself: every request is aborted after
// REQUEST_TIMEOUT_MS. That abort reaches the socket, not the server — the Express
// handler runs on and its transaction commits — so the operator is told the save failed
// while it actually landed. Tapping Save again then either edits the order a second time
// (two edits seconds apart, which is what staging order 2218 shows) or is refused with
// ADR 0019's `409 stale_write`, against a revision its own unreported write superseded.
//
// The fix is the same one creates already have (ADR 0017 #9, requestKeys.js): the write
// carries a client-generated key, and the server answers a key it already holds with the
// stored order instead of writing again. What differs is only WHERE the key comes from.
// The outbox mints one per queued record and keeps it in the record, because a record is
// a durable thing that outlives the app. A live screen has no such record — there is just
// an operator who tapped Save, watched it fail, and tapped it again — so the key has to be
// remembered by the ATTEMPT instead.
//
// ── What counts as "the same attempt" ───────────────────────────────────────
//
// The intent signature: method, path, and the body with two fields removed.
//
//   `revision` is removed because the retry's revision routinely differs from the
//   original's. foregroundOrderSync (ADR 0019) re-reads orders every five seconds, so by
//   the time the operator taps Save again the screen usually holds the revision that the
//   failed-but-committed write itself produced. Keying on the body verbatim would mint a
//   fresh key for that retry and commit the edit twice — exactly the bug.
//
//   `request_key` is removed so a body that already carries one (the outbox injects its
//   record's key before this ever sees it) is left alone entirely.
//
// ── What counts as a DIFFERENT write ────────────────────────────────────────
//
// A key is remembered only while its attempt's outcome is UNKNOWN — a network failure or
// our own timeout abort, the one case where the server may or may not have committed. Any
// answer from the server, success or refusal, forgets it immediately. So an operator who
// edits the order again after a successful save gets a fresh key and a normal write, even
// if they happen to retype the identical values; nothing is deduplicated against a write
// that is already known to have finished.
//
// That forgetting is scoped to the ORDER, not just the one signature. An answer to ANY
// mutation of order 5 — `/orders/5`, `/orders/5/status`, `/orders/5/adjustment`, … —
// drops every key held for order 5. Once a later write to that order has been answered,
// this device holds fresh knowledge of its state, and an earlier unknown attempt is no
// longer a retry: dispatch (timed out, committed), revert to pending (answered), then
// dispatch again must be a real transition, not a replay of the spent first key that the
// server would answer with the still-pending order. Keys held for other orders are
// untouched.

// ── Deliberately in memory, not in `v25.` storage ───────────────────────────
//
// The held key covers one operator's next tap, seconds later, on a screen that is still
// open. If the app is killed in between, the unsaved edit in the form is gone with it —
// so there is nothing left to retry, and the operator comes back to an order that
// already shows the edit their "failed" save actually made. Persisting the key would buy
// nothing the form state does not also need, and D17's storage rules exist for durable
// device state (the outbox, receipt history), which this is not.

import { newRequestKey } from './requestKeys.js';

// Mutations of an order that ALREADY EXISTS. `POST /orders` is deliberately absent: a
// create already has its own identity on the wire (the outbox record's key, or the
// receipt number as the pre-039 fallback), and deriving a key from its body instead
// would let two genuinely separate sales of the same goods collapse into one.
const ORDER_MUTATION_PATH =
  /^\/orders\/([^/?]+)(\/(status|close|finalize|adjustment|receipt-printed))?$/;

const KEYED_METHODS = new Set(['POST', 'PATCH']);

// Only attempts whose outcome is unknown are held, so this stays tiny in practice. The
// bounds are there for the pathological case of a device that spends an hour unable to
// reach the server: expire on age first, then oldest-first if it somehow still grows.
const TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED = 64;

const pendingKeys = new Map(); // signature → { key, at, order }

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [signature, held] of pendingKeys) {
    if (held.at < cutoff) pendingKeys.delete(signature);
  }
  // Map iterates in insertion order and every write re-inserts, so the first entries are
  // the least recently touched.
  while (pendingKeys.size > MAX_TRACKED) {
    pendingKeys.delete(pendingKeys.keys().next().value);
  }
}

function intentSignature(path, method, body) {
  const { revision: _revision, request_key: _requestKey, ...rest } = body;
  return `${method} ${path} ${JSON.stringify(rest)}`;
}

/**
 * Decides whether this request is a guarded order mutation and, if so, returns the body
 * to send with a `request_key` on it plus the signature the caller reports the outcome
 * under. Returns null for everything else, which is every other request in the app.
 *
 * A body that already carries a key (an outbox record's own) is passed through
 * untouched: the record IS the attempt in that case, and its key is the better one.
 */
export function prepareMutationKey(path, method, rawBody) {
  if (!KEYED_METHODS.has(method)) return null;
  const match = ORDER_MUTATION_PATH.exec(path);
  if (!match) return null;
  if (typeof rawBody !== 'string' || !rawBody) return null;

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.request_key) return null;

  prune();
  const signature = intentSignature(path, method, body);
  const held = pendingKeys.get(signature);
  const key = held ? held.key : newRequestKey();
  return {
    signature, key, order: match[1], body: JSON.stringify({ ...body, request_key: key }),
  };
}

/**
 * The attempt ended without an answer (a network failure, or client.js's own timeout
 * abort). The server may or may not have committed, so hold the key: the next attempt at
 * the same intent resends it and the server settles the question.
 */
export function rememberMutationKey(signature, key, order) {
  if (!signature || !key) return;
  pendingKeys.delete(signature);
  pendingKeys.set(signature, { key, at: Date.now(), order });
  prune();
}

/**
 * The server answered — success or refusal. Either way the question is settled, and not
 * just for this signature: every key held for the same order is dropped with it.
 */
export function forgetMutationKey(signature, order) {
  if (signature) pendingKeys.delete(signature);
  if (order == null) return;
  for (const [held, entry] of pendingKeys) {
    if (entry.order === order) pendingKeys.delete(held);
  }
}

/** Test seam. Nothing in the app clears the whole map. */
export function __resetMutationKeys() {
  pendingKeys.clear();
}
