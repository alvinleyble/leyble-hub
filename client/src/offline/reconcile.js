import { nativeStore } from './nativeStore.js';
import { NS, RECONCILE_PREFIX, reconcileKey } from './keys.js';

// ADR 0015 §6 — "Mandatory Human Conflict Reconciliation (No Silent Last-Write-Wins)".
//
// Two tablets both go blind. Both correct the same product's physical stock count —
// one says 50 cases, one says 40 — or both retag its price. When the line comes back
// the outbox would happily send whichever drained second, and the store would be left
// holding a number nobody counted. The captain rejected that outright (§6 Option D):
// a stock count is a claim about the physical world, and only a person standing in
// the warehouse can settle two of them.
//
// ── Why these are NOT outbox records ────────────────────────────────────────
//
// The outbox's `needs_attention` list is for records the SERVER REFUSED: one side is
// wrong, and the fix is to re-point the record and send it again. A stock conflict is
// the opposite shape — both values are valid inputs, nothing is wrong, and the answer
// is not in the app at all. So a conflict lives in its own space (`v25.reconcile.*`)
// as a QUESTION rather than a pending write, and answering it enqueues an ordinary,
// fresh outbox record. That also means a conflict can never be "retried": there is
// nothing to retry until a human has spoken.
//
// ── What counts as a conflict (see stockGuard in productMutations.js) ───────
//
// NOT "the server's number moved". It moves all day on its own: every dispatched
// order deducts stock, every logged delivery adds it. Flagging those would bury the
// signal in noise and teach the owners to tap through the modal without reading it.
//
// A conflict is specifically ANOTHER HUMAN'S EDIT TO THE SAME FIELD while this
// device was queued: an `inventory_audit_logs` row with `action_type`
// `manual_adjustment` on `current_stock` (or `price_change` on
// `base_wholesale_price`) dated after this record was queued. That is exactly the
// two-tablets-both-counting case §6 describes, and nothing else.

const NEXT_ID_KEY = `${NS}reconcile.nextId`;

async function nextConflictId() {
  const raw = await nativeStore.getString(NEXT_ID_KEY);
  const next = (Number(raw) || 0) + 1;
  await nativeStore.setString(NEXT_ID_KEY, next);
  return next;
}

export const STOCK_FIELD = 'current_stock';
export const PRICE_FIELD = 'base_wholesale_price';

/**
 * Records one unanswered question.
 *
 * @param {object} c
 * @param {number} c.productId
 * @param {string} c.productName
 * @param {string} c.field          STOCK_FIELD | PRICE_FIELD
 * @param {number} c.mine           what this tablet's operator entered
 * @param {number} c.theirs         what the server holds now (the other tablet's value)
 * @param {number} c.baseline       what this tablet believed before its own edit
 * @param {string} c.profileKey     D14 — the profile that made the edit being held
 * @param {string} [c.unit]
 * @param {string} [c.reason]       the reason typed alongside the original edit
 * @param {string} [c.theirReason]  the reason the other tablet's operator gave
 * @param {string} [c.theirAt]      when the other edit landed
 * @param {string} [c.queuedAt]     when this tablet's edit was saved
 */
export async function recordConflict({
  productId, productName, field, mine, theirs, baseline, profileKey,
  unit = '', reason = null, theirReason = null, theirAt = null, queuedAt = null,
}) {
  if (!profileKey) {
    // Same rule the outbox enforces (D14): whatever the operator finally confirms is
    // written as an edit BY SOMEONE, and it must be the person who made it, not
    // whoever happens to be holding the tablet when the line returns.
    throw new Error('recordConflict: profileKey is required — capture the profile at Save');
  }
  const id = await nextConflictId();
  const conflict = {
    id,
    product_id: productId,
    product_name: productName,
    field,
    mine: Number(mine),
    theirs: Number(theirs),
    baseline: baseline === null || baseline === undefined ? null : Number(baseline),
    unit,
    reason,
    their_reason: theirReason,
    their_at: theirAt,
    queued_at: queuedAt,
    profile_key: profileKey,
    detected_at: new Date().toISOString(),
  };
  await nativeStore.setJson(reconcileKey(id), conflict);
  notifyConflictListeners({ type: 'record', conflict });
  return conflict;
}

// Oldest first — the same key-order-is-insertion-order trick the outbox uses.
export async function listConflicts() {
  const keys = (await nativeStore.keysWithPrefix(RECONCILE_PREFIX)).filter((k) => k !== NEXT_ID_KEY);
  const out = [];
  for (const key of keys) {
    const conflict = await nativeStore.getJson(key);
    if (conflict) out.push(conflict);
  }
  return out;
}

export async function conflictCount() {
  return (await listConflicts()).length;
}

/**
 * Is there already an open question about this product's field? Used by the guard to
 * avoid stacking a second identical question behind an unanswered one.
 */
export async function hasOpenConflict(productId, field) {
  const open = await listConflicts();
  return open.some((c) => String(c.product_id) === String(productId) && c.field === field);
}

export async function removeConflict(id) {
  await nativeStore.remove(reconcileKey(id));
  notifyConflictListeners({ type: 'remove', id });
}

// ── Observers ───────────────────────────────────────────────────────────────

const listeners = new Set();

export function subscribeConflicts(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyConflictListeners(event = {}) {
  for (const listener of listeners) {
    try { listener(event); } catch {}
  }
}

// Test seam.
export async function __clearConflicts() {
  for (const key of await nativeStore.keysWithPrefix(RECONCILE_PREFIX)) await nativeStore.remove(key);
  notifyConflictListeners({ type: 'clear' });
}
