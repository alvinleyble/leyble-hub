// A queued manual stock correction vs. ORDINARY BUSINESS ACTIVITY on the same product.
//
// ADR 0015 §6's guard only ever looked for a competing HUMAN edit — another person's
// `manual_adjustment` / `price_change` — before resending its absolute value. Everything
// else that moves stock (an order dispatched, cancelled or edited; a delivery logged or
// reversed) was correctly not called a conflict, but was then also not accounted for at
// all: the queued count went out as an absolute number and erased whatever had landed
// while it waited.
//
//   Tablet A, blind at 09:00, counts 50 cases (it believed 55).
//   Tablet B sells 5 of them; that order drains at 09:30 and the server reads 50.
//   A's outbox drains at 09:40 and PATCHes current_stock = 50 — B's sale, gone,
//   with no conflict ever raised and nothing on screen to say so.
//
// The fix re-derives the queued count as a delta against the movements the server
// logged after the record was queued: 50 counted, 5 sold since ⇒ 45. Nobody is asked
// anything, because nobody disagrees.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { __clearOutbox, listRecords, drainOutbox } from '../src/offline/outbox.js';
import {
  listConflicts, __clearConflicts, STOCK_FIELD, PRICE_FIELD,
  CAUSE_COMPETING_EDIT, CAUSE_UNEXPLAINED_MOVEMENT,
} from '../src/offline/reconcile.js';
import {
  updateProductLocalFirst, screenProductMutations, stockDriftSinceQueued,
} from '../src/offline/productMutations.js';
import { applyCatalogueDelta, getCachedProducts } from '../src/offline/catalogue.js';

const offline = () => new Error('Failed to fetch');

const PRODUCT = {
  id: 1, name: 'Coke 1.5L', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
  base_wholesale_price: 400, deposit_fee: 0, current_stock: 55, units_per_case: 12,
  requires_bottle_return: false, is_active: true,
};

const QUEUED_AT = '2026-08-29T09:00:00.000Z';

// A stock movement the SERVER logged, of the shape GET /products/:id returns.
const movement = (over = {}) => ({
  id: 1, action_type: 'order_fulfillment', field_changed: 'current_stock',
  previous_value: '55', new_value: '50', delta: '-5', reason: 'Order 1-00007 dispatched',
  created_at: '2026-08-29T09:30:00.000Z', ...over,
});

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  await __clearConflicts();
  await applyCatalogueDelta('products', [PRODUCT]);
});

afterEach(() => { Object.assign(api, saved); });

/**
 * Queues a blind product edit and back-dates the outbox record to 09:00, so the audit
 * entries a test hands back are unambiguously "after this record was queued".
 */
async function queueBlindEdit(patch, { guardFields = [STOCK_FIELD], product = PRODUCT } = {}) {
  api.request = async () => { throw offline(); };
  api.get     = async () => { throw offline(); };
  await updateProductLocalFirst(product.id, patch, {
    profileKey: 'josie', product, guardFields, reason: patch.reason || null,
  });
  const [record] = await listRecords();
  record.created_at = QUEUED_AT;
  await nativeStore.setJson(`v25.outbox.${String(record.id).padStart(12, '0')}`, record);
  return record;
}

/** Puts the line back up, answering the guard's product read with `server`. */
function lineReturns(server) {
  const posted = [];
  api.get = async () => server;
  api.request = async (path, opts) => {
    posted.push({ path, method: opts.method, body: JSON.parse(opts.body) });
    return { id: PRODUCT.id };
  };
  return posted;
}

// ── The regression this file exists for ──────────────────────────────────────

test('a queued count re-derives as a delta over a sale that landed first — it never overwrites it', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });

  // Five cases were sold and dispatched at 09:30, so the server now reads 50 — the
  // same number this tablet counted, arrived at a completely different way.
  const posted = lineReturns({
    ...PRODUCT, current_stock: 50, audit_log: [movement()],
  });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 0, 'a sale is not a conflict — nobody disagreed about anything');
  await drainOutbox();

  assert.equal(posted.length, 1, 'the edit still sends — it is not held for a human');
  assert.equal(posted[0].body.current_stock, 45,
    '50 counted, 5 sold since ⇒ 45. Sending 50 would have erased the sale.');
  assert.equal((await listConflicts()).length, 0);
  assert.equal((await listRecords()).length, 0);
});

test('the re-derived value is what the Inventory screen shows too, not the raw count', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  lineReturns({ ...PRODUCT, current_stock: 50, audit_log: [movement()] });

  await screenProductMutations();

  const [held] = await getCachedProducts();
  assert.equal(Number(held.current_stock), 45,
    'the held copy tracks what will actually land, or the operator reads 50 forever');
});

test('a delivery logged while the count waited is added on, not overwritten', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 65,
    audit_log: [movement({ action_type: 'restock', delta: '10', new_value: '65',
                           reason: 'Supplier delivery: San Miguel' })],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 60, '50 counted + 10 delivered since');
});

test('several movements since the count are summed, whatever mix of kinds they are', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 51,
    audit_log: [
      movement({ id: 3, action_type: 'restock',        delta: '12', created_at: '2026-08-29T11:00:00.000Z' }),
      movement({ id: 2, action_type: 'order_cancel',   delta: '4',  created_at: '2026-08-29T10:00:00.000Z' }),
      movement({ id: 1, action_type: 'order_fulfillment', delta: '-20', created_at: '2026-08-29T09:30:00.000Z' }),
    ],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 46, '50 − 20 + 4 + 12');
});

test('an order EDIT that moved stock counts too — order_edit is business, not a second count', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 52,
    audit_log: [movement({ action_type: 'order_edit', delta: '-3', new_value: '52' })],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 47);
});

test('a delivery edit/void reversal counts as business movement, not a competing count', async () => {
  // Secondary fix (migration 038): this reversal used to be logged `manual_adjustment`,
  // which the guard reads as another human's recount, and it raised a question about a
  // number nobody disputed. As `delivery_edit` it re-derives like any other movement.
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 49,
    audit_log: [movement({ action_type: 'delivery_edit', delta: '-6', new_value: '49',
                           reason: 'Delivery corrected' })],
  });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 0, 'no human reconciliation for a delivery correction');
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 44);
});

// ── Guarding the boundaries of the new behaviour ─────────────────────────────

test('movement from BEFORE the count was queued is already in the count — the absolute value stands', async () => {
  // The device's baseline was simply stale: the sale happened before the operator
  // walked the shelf, so 50 already reflects it. Re-deriving here would double-count.
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 50,
    audit_log: [movement({ created_at: '2026-08-29T08:00:00.000Z' })],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 50);
});

test('nothing moved at all: the count still sends exactly as it was typed', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({ ...PRODUCT, current_stock: 55, audit_log: [] });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, 50);
});

test('a competing HUMAN count still becomes a question, and still sends nothing', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 40,
    audit_log: [movement({ action_type: 'manual_adjustment', delta: '-15', new_value: '40',
                           reason: 'Counted 40' })],
  });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 1);
  await drainOutbox();
  assert.deepEqual(posted, [], '§6 forbids resolving two honest counts silently');

  const [conflict] = await listConflicts();
  assert.equal(conflict.mine, 50);
  assert.equal(conflict.theirs, 40);
  assert.equal(conflict.cause, CAUSE_COMPETING_EDIT);
  assert.equal(conflict.their_reason, 'Counted 40');
});

test('a human count that other movements netted back to the baseline is never re-derived over', async () => {
  // findCompetingEdit short-circuits when the server's value equals the baseline, so
  // this human edit is not flagged (pre-existing, unchanged). What must NOT happen is
  // the new delta path stepping in and quietly overwriting that person's count using
  // the business movements alone.
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 55,
    audit_log: [
      movement({ id: 2, action_type: 'manual_adjustment', delta: '5', new_value: '55',
                 created_at: '2026-08-29T10:00:00.000Z' }),
      movement({ id: 1, action_type: 'order_fulfillment', delta: '-5', new_value: '50',
                 created_at: '2026-08-29T09:30:00.000Z' }),
    ],
  });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 1, 'unaccountable — so it is a question, not a silent arithmetic answer');
  await drainOutbox();
  assert.deepEqual(posted, []);
  assert.equal((await listConflicts())[0].cause, CAUSE_UNEXPLAINED_MOVEMENT);
});

test('a truncated audit window is unknowable, so it falls back to human reconciliation', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  // A full page of 50 entries, every one of them newer than this record: whatever fell
  // off the end of the page is invisible, so the drift cannot be proved.
  const full = Array.from({ length: 50 }, (_, i) => movement({
    id: i + 1, delta: '-1',
    created_at: new Date(Date.parse(QUEUED_AT) + (i + 1) * 60000).toISOString(),
  }));
  const posted = lineReturns({ ...PRODUCT, current_stock: 5, audit_log: full });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 1);
  await drainOutbox();
  assert.deepEqual(posted, [], 'better to ask than to send a number derived from a partial view');

  const [conflict] = await listConflicts();
  assert.equal(conflict.cause, CAUSE_UNEXPLAINED_MOVEMENT);
  assert.equal(conflict.their_reason, null, 'nobody made a competing edit — do not invent one');
  assert.equal(conflict.mine, 50);
  assert.equal(conflict.theirs, 5);
});

test('a stock movement with no usable delta is unknowable rather than assumed to be zero', async () => {
  await queueBlindEdit({ current_stock: 50, reason: 'Counted 50' });
  lineReturns({
    ...PRODUCT, current_stock: 48,
    audit_log: [movement({ delta: null, new_value: '48' })],
  });

  const res = await screenProductMutations();
  assert.equal(res.conflicts, 1);
  assert.equal((await listConflicts())[0].cause, CAUSE_UNEXPLAINED_MOVEMENT);
});

test('the rest of the same edit still sends when only the count was re-derived', async () => {
  await queueBlindEdit({ name: 'Coke 1.5L (case)', current_stock: 50 });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 50, audit_log: [movement()],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.name, 'Coke 1.5L (case)');
  assert.equal(posted[0].body.current_stock, 45);
});

test('a PRICE is never re-derived — stock moving on its own says nothing about price', async () => {
  await queueBlindEdit({ base_wholesale_price: 430 }, { guardFields: [PRICE_FIELD] });
  const posted = lineReturns({
    ...PRODUCT, current_stock: 50, base_wholesale_price: 400,
    audit_log: [movement()],
  });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.base_wholesale_price, 430, 'a price plus a delta is not a thing');
  assert.equal((await listConflicts()).length, 0);
});

test('a field the operator did not change is never resurrected into the payload', async () => {
  // updateProductLocalFirst drops an unchanged guarded field entirely. The re-derivation
  // writes back onto the payload, and must not put a dropped field back into the body.
  await queueBlindEdit({ name: 'Coke 1.5L (case)', current_stock: PRODUCT.current_stock });
  const posted = lineReturns({ ...PRODUCT, current_stock: 50, audit_log: [movement()] });

  await screenProductMutations();
  await drainOutbox();
  assert.equal(posted[0].body.current_stock, undefined,
    'no stock in this save at all — the operator only renamed the product');
});

// ── The derivation itself ────────────────────────────────────────────────────

test('stockDriftSinceQueued: sums only stock entries newer than the record', async () => {
  const check = { field: STOCK_FIELD, baseline: 55, mine: 50 };
  const server = {
    current_stock: 48,
    audit_log: [
      movement({ id: 3, delta: '-2', created_at: '2026-08-29T10:00:00.000Z' }),
      movement({ id: 2, field_changed: 'base_wholesale_price', action_type: 'price_change',
                 delta: null, created_at: '2026-08-29T10:00:00.000Z' }),
      movement({ id: 1, delta: '-5', created_at: '2026-08-29T08:00:00.000Z' }),
    ],
  };
  assert.equal(stockDriftSinceQueued(server, check, QUEUED_AT), -2);
});

test('stockDriftSinceQueued: half-case movements survive the arithmetic', async () => {
  const check = { field: STOCK_FIELD, baseline: 55, mine: 50 };
  const server = {
    current_stock: 54.5,
    audit_log: [movement({ delta: '-0.5', new_value: '54.5' })],
  };
  assert.equal(stockDriftSinceQueued(server, check, QUEUED_AT), -0.5);
});

test('stockDriftSinceQueued: an unmoved server value needs no derivation', async () => {
  const check = { field: STOCK_FIELD, baseline: 55, mine: 50 };
  assert.equal(stockDriftSinceQueued({ current_stock: 55, audit_log: [] }, check, QUEUED_AT), 0);
});
