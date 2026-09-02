import { api } from '../api/client.js';
import { enqueue, drainOutbox, listRecords, QUEUED } from './outbox.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { applyCatalogueDelta, getCachedEntity } from './catalogue.js';
import {
  recordConflict, hasOpenConflict, removeConflict, listConflicts,
  STOCK_FIELD, PRICE_FIELD,
  CAUSE_COMPETING_EDIT, CAUSE_UNEXPLAINED_MOVEMENT,
} from './reconcile.js';
import { nativeStore } from './nativeStore.js';
import { outboxKey } from './keys.js';

// ADR 0015 §6 — full offline CRUD for products and stock, with human reconciliation.
//
// This supersedes ADR 0005 §2 ("stock adjustments and batch price edits are strictly
// online-only"): physical stocktakes happen during the outage, not after it, and the
// old rule sent the owners back to loose paper.
//
// Everything here takes ONE code path online and blind, like CustomerFormModal: queue
// it, drain immediately. On a connected tablet the drain lands it in about a second
// and the operator sees the ordinary toast; blind, it waits.
//
// The exception, and it is deliberate: **DELETE stays online-only** (captain decision,
// Slice 3.3). Unlike a count or a price, there is no reconciliation for "tablet A
// deleted the product, tablet B is mid-sale on it" — there is no second value to weigh,
// only a row that either exists or does not. It gets the same treatment as customer
// merges (§7) and delivery voids (§8): disabled offline with a tooltip.

// ── Local-first writes ──────────────────────────────────────────────────────

/**
 * Queue a new product. Additive and conflict-free, so it needs no guard.
 * The row has no id until it syncs; the Inventory list merges it in from the outbox
 * (queuedProductsFromOutbox below), the same way the directory shows queued customers.
 */
export async function createProductLocalFirst(payload, { profileKey }) {
  const record = await enqueue({
    entityType: 'product',
    endpoint:   '/products',
    method:     'POST',
    payload,
    profileKey,
  });
  const synced = await drainNow(record.id);
  return { record, synced };
}

/**
 * Queue an edit to an existing product.
 *
 * `guardFields` names the fields whose value another tablet could also be correcting
 * right now — stock and base price. For each one we remember what THIS device believed
 * before the edit (`baseline`), which is what makes a competing edit detectable at
 * drain time without a version column on the table.
 *
 * The held catalogue copy is updated straight away so the Inventory list, the product
 * panel and every picker show what the operator just typed instead of silently
 * reverting to the pre-edit value on the next render.
 */
export async function updateProductLocalFirst(productId, patch, {
  profileKey, product, guardFields = [], reason = null,
}) {
  // A guarded field the operator did not actually change is DROPPED from the payload
  // rather than guarded. The full details form always sends stock and price, changed or
  // not; sending an unchanged one would silently clobber a count another tablet made
  // while this edit was queued, and guarding it would ask a person to adjudicate an
  // edit nobody made. Neither is right — the field simply has no business in this save.
  const body = { ...patch };
  const contested = [];
  for (const field of guardFields) {
    if (body[field] === undefined) continue;
    if (product && Number(body[field]) === Number(product[field])) {
      delete body[field];
      continue;
    }
    contested.push(field);
  }

  const checks = contested
    .map((field) => ({
      product_id:   productId,
      product_name: product?.name || 'Product',
      field,
      baseline:     product ? Number(product[field]) : null,
      mine:         Number(body[field]),
      unit:         product?.unit || '',
      reason,
    }));

  const record = await enqueue({
    entityType: 'product_update',
    endpoint:   `/products/${productId}`,
    method:     'PATCH',
    payload:    body,
    profileKey,
  });
  if (checks.length) await attachGuard(record.id, { kind: 'product_patch', checks });

  await applyLocalProductPatch(productId, body);

  const synced = await drainNow(record.id);
  return { record, synced };
}

/**
 * Queue a batch price edit. One outbox record, one guard check per product — a
 * conflict on one product must not hold up the other 40 (see screenProductMutations).
 */
export async function batchPriceLocalFirst(updates, reason, { profileKey, products = [] }) {
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const checks = updates.map((u) => ({
    product_id:   u.id,
    product_name: byId.get(String(u.id))?.name || 'Product',
    field:        PRICE_FIELD,
    baseline:     byId.has(String(u.id)) ? Number(byId.get(String(u.id)).base_wholesale_price) : null,
    mine:         Number(u.new_price),
    unit:         byId.get(String(u.id))?.unit || '',
    reason,
  }));

  const record = await enqueue({
    entityType: 'product_batch_price',
    endpoint:   '/products/batch-price',
    method:     'PATCH',
    payload:    { updates, reason: reason || null },
    profileKey,
  });
  await attachGuard(record.id, { kind: 'batch_price', checks });

  for (const u of updates) {
    await applyLocalProductPatch(u.id, { base_wholesale_price: Number(u.new_price) });
  }

  const synced = await drainNow(record.id);
  return { record, synced };
}

// Writes a field change onto the held catalogue copy, so a blind edit is visible on
// every screen that reads the cache rather than vanishing on the next render.
async function applyLocalProductPatch(productId, patch) {
  try {
    const held = await getCachedEntity('products');
    const row = held.find((p) => String(p.id) === String(productId));
    if (!row) return;
    const { reason, ...fields } = patch;
    await applyCatalogueDelta('products', [{ ...row, ...fields }]);
  } catch {
    // The cache is a convenience here; failing to update it must never fail the save.
  }
}

// The guard rides on the outbox record itself, not in a parallel store: a record and
// the question it might raise must not be able to drift apart (one removed, the other
// orphaned) across an interrupted drain.
async function attachGuard(recordId, guard) {
  const record = await nativeStore.getJson(outboxKey(recordId));
  if (!record) return;
  record.guard = guard;
  await nativeStore.setJson(outboxKey(recordId), record);
}

// Screen, drain, and report whether this particular record actually made it. The
// caller uses that to word its toast ("updated" vs "saved on this device").
async function drainNow(recordId) {
  await screenProductMutations().catch(() => {});
  const res = await drainOutbox().catch(() => null);
  // Every drain that can fire outside the 30s periodic loop routes its own result
  // through the notifier, or no screen ever hears about it (Round 2 Fix 1).
  if (res && res.sent > 0) handleDrainCompletion(res).catch(() => {});
  const stillQueued = (await listRecords().catch(() => []))
    .some((r) => r.id === recordId);
  return !stillQueued;
}

// ── The conflict guard (ADR 0015 §6) ────────────────────────────────────────

// An audit entry written by a PERSON deliberately setting the value, as opposed to
// stock moving because something was sold, delivered, or an order was edited. Only
// the former is a competing claim about the same fact; the latter is just business
// happening, and flagging it would bury the real signal.
const HUMAN_ACTION_FOR_FIELD = {
  [STOCK_FIELD]: 'manual_adjustment',
  [PRICE_FIELD]: 'price_change',
};

// GET /api/v1/products/:id — "includes last 50 audit log entries".
const AUDIT_LOG_PAGE = 50;

/**
 * Runs before every drain pass. For each queued product mutation carrying a guard,
 * asks the server what the product looks like now and whether anyone else corrected
 * the same field while this record was waiting.
 *
 * Clean checks are left alone — the drain sends them a moment later. A conflicting
 * check is LIFTED OUT of the record (the field is stripped from the PATCH body, or the
 * product is dropped from the batch) and becomes a question in the reconcile store, so
 * the rest of the operator's edit still lands and only the genuinely contested value
 * waits on a human.
 *
 * A check that is clean but whose server value moved for ORDINARY BUSINESS REASONS —
 * an order dispatched, cancelled or edited, a delivery logged — is neither left alone
 * nor turned into a question: the queued count is re-derived as a delta against those
 * movements (stockDriftSinceQueued) so it stops being an absolute overwrite. That is
 * the fix for the silent clobber where a stocktake queued at 09:00 erased a sale that
 * landed at 09:30 simply by draining second.
 *
 * Requires a connection by construction: with no line the product read throws, this
 * returns having done nothing, and everything stays queued exactly as before. That is
 * the right failure — an unscreened record must never be sent.
 */
export async function screenProductMutations() {
  const records = (await listRecords()).filter((r) => r.status === QUEUED && r.guard?.checks?.length);
  if (records.length === 0) return { checked: 0, conflicts: 0 };

  let conflicts = 0;
  let checked = 0;

  for (const record of records) {
    const survivors = [];
    // Guarded fields whose queued value was re-derived on this pass — written back onto
    // the outbox payload once, alongside the screened stamp, rather than per check.
    const rederivations = {};
    for (const check of record.guard.checks) {
      checked++;
      let server;
      try {
        server = await api.get(`/products/${check.product_id}`);
      } catch (err) {
        if (!err?.status) return { checked, conflicts, offline: true }; // no line — stop, change nothing
        // A 404/400 on the product is the outbox's own needs-attention territory, not
        // a reconciliation question. Let the drain send it and let the server refuse.
        survivors.push(check);
        continue;
      }

      const competing = findCompetingEdit(server, check, record.created_at);

      if (!competing) {
        // No second opinion — but the server's number may still have moved because
        // something was sold, cancelled, edited or delivered while this record waited.
        // Resending the counted number as an absolute would erase that movement, so
        // re-derive it as a delta instead (see the header comment in reconcile.js).
        const drift = stockDriftSinceQueued(server, check, record.created_at);
        if (drift === null) {
          // Unknowable: the audit window is truncated, so we cannot tell what moved.
          // §6's answer to "we cannot settle this" is always the same — ask a person.
          await raiseQuestion({
            record, check, server, competing: null, cause: CAUSE_UNEXPLAINED_MOVEMENT,
          });
          conflicts++;
          continue;
        }
        if (drift !== 0) {
          const rederived = Number(check.mine) + drift;
          rederivations[check.field] = rederived;
          await applyLocalProductPatch(check.product_id, { [check.field]: rederived });
        }
        survivors.push(check);
        continue;
      }

      await raiseQuestion({ record, check, server, competing, cause: CAUSE_COMPETING_EDIT });
      conflicts++;
    }

    if (survivors.length !== record.guard.checks.length) {
      await rewriteRecord(record, survivors, rederivations);
    } else {
      await stampScreened(record, rederivations);
    }
  }

  return { checked, conflicts };
}

// Records the question a contested field becomes. Don't stack a second identical
// question behind an unanswered one — the operator would be asked the same thing twice
// about the same product.
async function raiseQuestion({ record, check, server, competing, cause }) {
  if (await hasOpenConflict(check.product_id, check.field)) return;
  await recordConflict({
    productId:   check.product_id,
    productName: server.name || check.product_name,
    field:       check.field,
    mine:        check.mine,
    theirs:      Number(server[check.field]),
    baseline:    check.baseline,
    unit:        server.unit || check.unit,
    reason:      check.reason,
    theirReason: competing?.reason || null,
    theirAt:     competing?.created_at || null,
    queuedAt:    record.created_at,
    profileKey:  record.profile_key,
    cause,
  });
}

// The drain refuses to send a guarded record that has not just been screened (see
// isFreshlyScreened in outbox.js), so a clean pass has to say so. `rederivations` is
// the {field: value} map of queued values this pass recomputed as a delta.
async function stampScreened(record, rederivations = {}) {
  const stored = await nativeStore.getJson(outboxKey(record.id));
  if (!stored?.guard) return;
  stored.payload = applyRederivations(stored.payload, rederivations);
  stored.guard = { ...stored.guard, screened_at: Date.now() };
  await nativeStore.setJson(outboxKey(record.id), stored);
}

// Writes re-derived values back onto the payload about to be sent. Only ever touches
// a field the payload already carries — a field that was dropped at save time (because
// the operator did not change it) must stay out of the body, not reappear here.
function applyRederivations(payload, rederivations) {
  const fields = Object.keys(rederivations || {});
  if (fields.length === 0) return payload;
  const next = { ...payload };
  for (const field of fields) {
    if (next[field] === undefined) continue;
    next[field] = rederivations[field];
  }
  return next;
}

// The server's own stock movements since this record was queued, summed.
//
// Returns 0 when nothing moved (send the counted value as it stands), a signed number
// when it did (send `counted + drift`), and null when the answer is unknowable and the
// value has to become a question instead. Unknowable means one of two things:
//
//   * the audit window is truncated — GET /products/:id returns the last 50 entries,
//     and if the oldest of a full 50 is still newer than this record, there may be
//     movements we simply cannot see; or
//   * a human `manual_adjustment` landed after this record was queued that
//     findCompetingEdit did not flag, which happens only when other movements netted
//     the server's value back to this device's baseline. Re-deriving over the business
//     movements alone would then quietly overwrite that person's count.
//
// Price is never re-derived: a price does not move on its own (only price_change,
// which is a human, i.e. a competing edit), and "price plus a delta" is not a
// meaningful thing to send anyway.
export function stockDriftSinceQueued(serverProduct, check, queuedAtIso) {
  if (check.field !== STOCK_FIELD) return 0;

  const queuedAt = Date.parse(queuedAtIso);
  if (Number.isNaN(queuedAt)) return 0; // no anchor to measure "since" from

  const log = Array.isArray(serverProduct?.audit_log) ? serverProduct.audit_log : [];
  const stockLog = log.filter((e) => e.field_changed === STOCK_FIELD);

  const since = [];
  for (const entry of stockLog) {
    const at = Date.parse(entry.created_at);
    if (Number.isNaN(at) || at <= queuedAt) continue;
    // Checked BEFORE the "nothing moved" shortcut below, on purpose: a human count
    // whose effect other movements happen to have netted back to this device's
    // baseline is invisible to findCompetingEdit, and arithmetic must not be what
    // quietly overwrites it.
    if (entry.action_type === HUMAN_ACTION_FOR_FIELD[STOCK_FIELD]) return null;
    since.push(entry);
  }

  if (since.length === 0) return 0;
  if (Number(serverProduct?.[check.field]) === Number(check.baseline)) return 0;

  // The window is only a worry when it is full AND every stock entry in it is newer
  // than this record — then whatever movement fell off the end is invisible here.
  if (log.length >= AUDIT_LOG_PAGE && since.length === stockLog.length) return null;

  let drift = 0;
  for (const entry of since) {
    // A stock entry with no usable delta (shouldn't happen — applyStockDelta and the
    // PATCH route both write one) leaves the sum unprovable, so stop guessing. Note
    // Number(null) is 0, which is exactly the wrong answer here.
    if (entry.delta === null || entry.delta === undefined || entry.delta === '') return null;
    const delta = Number(entry.delta);
    if (!Number.isFinite(delta)) return null;
    drift += delta;
  }
  return drift;
}

// The competing edit, if there is one: a human setting the same field after this
// record was queued. `previous_value`/`new_value` come back as strings from the API.
export function findCompetingEdit(serverProduct, check, queuedAtIso) {
  const wanted = HUMAN_ACTION_FOR_FIELD[check.field];
  if (!wanted) return null;
  if (Number(serverProduct?.[check.field]) === Number(check.baseline)) return null;

  const queuedAt = Date.parse(queuedAtIso);
  const log = Array.isArray(serverProduct?.audit_log) ? serverProduct.audit_log : [];
  return log.find((e) =>
    e.field_changed === check.field &&
    e.action_type === wanted &&
    !Number.isNaN(Date.parse(e.created_at)) &&
    (Number.isNaN(queuedAt) || Date.parse(e.created_at) > queuedAt)
  ) || null;
}

// Removes the contested fields from a record. What is left is still a real edit and
// still worth sending; a record with nothing left is dropped, because the only thing
// it carried is now a question instead.
async function rewriteRecord(record, survivors, rederivations = {}) {
  const stored = await nativeStore.getJson(outboxKey(record.id));
  if (!stored) return;
  stored.payload = applyRederivations(stored.payload, rederivations);

  if (record.guard.kind === 'batch_price') {
    const keep = new Set(survivors.map((c) => String(c.product_id)));
    stored.payload = {
      ...stored.payload,
      updates: (stored.payload.updates || []).filter((u) => keep.has(String(u.id))),
    };
    if (stored.payload.updates.length === 0) {
      await nativeStore.remove(outboxKey(record.id));
      return;
    }
  } else {
    const dropped = record.guard.checks
      .filter((c) => !survivors.some((s) => s.field === c.field))
      .map((c) => c.field);
    const payload = { ...stored.payload };
    for (const field of dropped) delete payload[field];
    const meaningful = Object.keys(payload).filter((k) => k !== 'reason');
    if (meaningful.length === 0) {
      await nativeStore.remove(outboxKey(record.id));
      return;
    }
    stored.payload = payload;
  }

  stored.guard = { ...record.guard, checks: survivors, screened_at: Date.now() };
  await nativeStore.setJson(outboxKey(record.id), stored);
}

// ── Answering a question ────────────────────────────────────────────────────

/**
 * The operator has confirmed the true value. Enqueues an ordinary write for it and
 * closes the question. `value` is whatever they confirmed: their own number, the
 * server's, or a third one they went and counted.
 *
 * Credited to the profile that made the ORIGINAL edit (D14) unless the caller passes
 * one — the person answering is usually the person who counted.
 */
export async function resolveConflict(conflictId, { value, reason, profileKey } = {}) {
  const conflict = (await listConflicts()).find((c) => c.id === conflictId);
  if (!conflict) return null;

  const confirmed = Number(value);
  if (!Number.isFinite(confirmed) || confirmed < 0) {
    throw new Error('Enter the confirmed value before saving.');
  }

  // Nothing to send when the confirmed value is already what the server holds — the
  // question is answered by agreeing with it.
  if (confirmed === Number(conflict.theirs)) {
    await removeConflict(conflictId);
    return { record: null, conflict };
  }

  const record = await enqueue({
    entityType: conflict.field === STOCK_FIELD ? 'product_stock_confirm' : 'product_price_confirm',
    endpoint:   `/products/${conflict.product_id}`,
    method:     'PATCH',
    payload: {
      [conflict.field]: confirmed,
      reason: reason
        || `Reconciled after offline edit (this device: ${conflict.mine}, server: ${conflict.theirs})`,
    },
    profileKey: profileKey || conflict.profile_key,
  });

  // Deliberately NOT guarded again. This value is a human's explicit answer to exactly
  // this question; re-screening it would ask them the same thing a second time.
  await applyLocalProductPatch(conflict.product_id, { [conflict.field]: confirmed });
  await removeConflict(conflictId);
  await drainNow(record.id);
  return { record, conflict };
}

/** Keep the other tablet's value: the question closes and nothing is sent. */
export async function keepServerValue(conflictId) {
  const conflict = (await listConflicts()).find((c) => c.id === conflictId);
  if (!conflict) return null;
  await applyLocalProductPatch(conflict.product_id, { [conflict.field]: Number(conflict.theirs) });
  await removeConflict(conflictId);
  return conflict;
}

// ── Queued creates, for the Inventory list ──────────────────────────────────

// Same job and same shape as queuedCustomersFromOutbox: a product added while blind
// has no server row yet, so a purely server-driven list would simply not show it.
export async function queuedProductsFromOutbox() {
  try {
    const records = await listRecords();
    return records
      .filter((r) => r.entity_type === 'product' && r.status === QUEUED)
      .map((r) => ({
        id: `local-${r.id}`,
        _outboxId: r.id,
        name: r.payload?.name || 'Product',
        category: r.payload?.category ?? null,
        unit: r.payload?.unit || '',
        sku: r.payload?.sku ?? null,
        base_wholesale_price: Number(r.payload?.base_wholesale_price) || 0,
        deposit_fee: Number(r.payload?.deposit_fee) || 0,
        current_stock: Number(r.payload?.current_stock) || 0,
        units_per_case: Number(r.payload?.units_per_case) || 1,
        requires_bottle_return: Boolean(r.payload?.requires_bottle_return),
        is_active: true,
        _unsynced: true,
      }));
  } catch {
    return [];
  }
}

// ── Queued EDITS to products that already exist on the server ───────────────
//
// Distinct from queuedProductsFromOutbox above, and the distinction is the whole
// point: a queued CREATE has no server row to show, so it is merged into the list as
// a `local-` row; a queued EDIT belongs to a row that is already on screen, showing
// the operator's new number (applyLocalProductPatch wrote it to the held copy), with
// nothing at all to say that number has not reached anyone else yet.
//
// Criteria 7.5 asks for the same "Waiting to sync" affordance offline-created
// customers and orders already carry, in BOTH directions — the freshly-added product
// and the freshly-edited one.
const PRODUCT_EDIT_ENTITY_TYPES = new Set([
  'product_update',
  'product_batch_price',
  'product_stock_confirm',
  'product_price_confirm',
]);

/** Ids (as strings) of existing products carrying an edit that has not drained yet. */
export async function pendingProductEditIds() {
  try {
    const records = await listRecords();
    const ids = new Set();
    for (const r of records) {
      if (r.status !== QUEUED || !PRODUCT_EDIT_ENTITY_TYPES.has(r.entity_type)) continue;
      if (r.entity_type === 'product_batch_price') {
        for (const u of r.payload?.updates || []) ids.add(String(u.id));
        continue;
      }
      const id = String(r.endpoint || '').split('/').pop();
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    // Best-effort, exactly like queuedProductsFromOutbox — a badge is never worth
    // failing the screen that asked for it.
    return new Set();
  }
}
