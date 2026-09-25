// Exactly-once order mutations, keyed on a client-generated request key.
//
// The defect: client/src/api/client.js aborts every request after 5 seconds. That abort
// reaches the socket, not this process — the Express handler runs on and its transaction
// commits — so the operator is told the save failed while it actually landed. The retry
// then either edits the order a SECOND time or is refused with ADR 0019's
// `409 stale_write` against a revision its own unreported write superseded.
//
// These tests assert on the stored row and its revision, never only on the HTTP status:
// "commits exactly once" is a statement about the database, and a 200 alone cannot make
// it. The first case aborts the client side for real, so the abort's non-cancellation of
// the handler is part of what is under test rather than an assumption.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const orderRoutes = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('request-key idempotency on order mutations (migration 050)', () => {
  let server;
  let baseUrl;
  let token;
  let userId;
  let customerId;
  let productId;
  const runKey = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Set by the abort test only: fires once the request body is fully parsed and the
  // route is about to run, which is the moment the client has to walk away for the
  // abort to be the real thing rather than a request that never left.
  let onRequestInFlight = null;
  let keySeq = 0;
  const nextKey = () => `rk_test${runKey.replace(/[^a-z0-9]/gi, '')}${++keySeq}`;

  before(async () => {
    const { rows: [user] } = await db.query(
      "SELECT id, email, full_name, role FROM users WHERE email = 'alvin@leyblestore.com'"
    );
    userId = user.id;
    token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );
    ({ rows: [{ id: customerId }] } = await db.query(
      "INSERT INTO customers (name, customer_type) VALUES ($1, 'regular') RETURNING id",
      [`TEST_RK050 Customer ${runKey}`]
    ));
    ({ rows: [{ id: productId }] } = await db.query(
      `INSERT INTO products (name, sku, unit, base_wholesale_price, current_stock)
       VALUES ($1, $2, 'cs', 100, 500) RETURNING id`,
      [`TEST_RK050 Product ${runKey}`, `RK050-${runKey}`]
    ));

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, _res, next) => {
      if (onRequestInFlight) onRequestInFlight(req);
      next();
    });
    app.use('/api/v1/orders', orderRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1/orders`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    // Append-only audit tables are left as they are: this suite runs against the
    // documented throwaway database and names every fixture uniquely.
  });

  async function createOrder(status = 'pending') {
    const { rows: [order] } = await db.query(
      `INSERT INTO orders (customer_id, status, order_type, total_amount, created_by)
       VALUES ($1, $2, 'delivery', 200, $3) RETURNING *`,
      [customerId, status, userId]
    );
    await db.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
       VALUES ($1, $2, 2, 100)`,
      [order.id, productId]
    );
    return order;
  }

  async function call(id, suffix, { method = 'POST', body, signal } = {}) {
    const response = await fetch(`${baseUrl}/${id}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }

  const storedOrder = async (id) => (await db.query(
    'SELECT notes, revision, status, adjustment, adjustment_reason FROM orders WHERE id = $1', [id]
  )).rows[0];

  const activityCount = async (id, action) => Number((await db.query(
    'SELECT COUNT(*)::int AS n FROM activity_logs WHERE entity_type = $1 AND entity_id = $2 AND action = $3',
    ['order', id, action]
  )).rows[0].n);

  const stockOf = async () => Number((await db.query(
    'SELECT current_stock FROM products WHERE id = $1', [productId]
  )).rows[0].current_stock);

  // Waits for the handler the client already walked away from to finish. Polling the row
  // rather than sleeping a fixed time is what keeps this deterministic.
  async function waitForStored(id, predicate, label) {
    for (let i = 0; i < 100; i++) {
      const row = await storedOrder(id);
      if (predicate(row)) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it('an edit the client aborted mid-flight, retried under the same key, commits exactly once', async () => {
    const order = await createOrder();
    const key = nextKey();
    const body = { notes: 'Aborted then retried', revision: order.revision, request_key: key };

    // The real shape of the bug: the client gives up on a request the server is already
    // running. AbortController is client-side only — nothing here tells the handler, so it
    // runs on to COMMIT. Waiting for the observer (installed after express.json, so the
    // body is fully read and the route is next) is what makes that deterministic instead
    // of aborting a request that never left the process.
    const inFlight = new Promise((resolve) => { onRequestInFlight = resolve; });
    const controller = new AbortController();
    const aborted = call(order.id, '', { method: 'PATCH', body, signal: controller.signal })
      .then(() => 'answered', (err) => err.name);
    await inFlight;
    onRequestInFlight = null;
    controller.abort();
    assert.equal(await aborted, 'AbortError', 'the client must have given up, not been answered');

    const committed = await waitForStored(
      order.id, (row) => row.notes === 'Aborted then retried', 'the abandoned write to commit'
    );
    assert.ok(
      BigInt(committed.revision) > BigInt(order.revision),
      'the aborted request must still have committed — that is the defect being guarded'
    );

    // The operator taps Save again. foregroundOrderSync has usually refreshed the screen
    // by now, so the retry carries the revision the failed write itself produced — which
    // is precisely why the key, not the body, has to decide what a retry is.
    const retry = await call(order.id, '', {
      method: 'PATCH',
      body: { notes: 'Aborted then retried', revision: committed.revision, request_key: key },
    });
    assert.equal(retry.status, 200);

    const after = await storedOrder(order.id);
    assert.equal(after.notes, 'Aborted then retried');
    assert.equal(
      after.revision, committed.revision,
      'the retry must not have written again — the revision proves it'
    );
    assert.equal(retry.body.revision, committed.revision, 'the reply carries the stored order');
    assert.equal(
      await activityCount(order.id, 'edited'), 1,
      'one edit in the activity log, not two'
    );
  });

  it('answers a replay whose revision is now STALE with the stored order, not a 409', async () => {
    const order = await createOrder();
    const key = nextKey();
    const body = { notes: 'Stale replay', revision: order.revision, request_key: key };

    const first = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(first.status, 200);

    // Byte-for-byte the same request, including the revision that is now behind by one.
    // Without the key this is ADR 0019's 409 — the order conflicting with itself.
    const replay = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.revision, first.body.revision);
    assert.equal((await storedOrder(order.id)).revision, first.body.revision);
  });

  it('still commits a genuinely different write carrying its own key', async () => {
    const order = await createOrder();
    const first = await call(order.id, '', {
      method: 'PATCH', body: { notes: 'First', revision: order.revision, request_key: nextKey() },
    });
    assert.equal(first.status, 200);

    const second = await call(order.id, '', {
      method: 'PATCH', body: { notes: 'Second', revision: first.body.revision, request_key: nextKey() },
    });
    assert.equal(second.status, 200);

    const stored = await storedOrder(order.id);
    assert.equal(stored.notes, 'Second');
    assert.ok(BigInt(stored.revision) > BigInt(first.body.revision));
    assert.equal(await activityCount(order.id, 'edited'), 2);
  });

  it('a request carrying no key behaves exactly as it did before', async () => {
    const order = await createOrder();
    const body = { notes: 'Keyless', revision: order.revision };

    const first = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(first.status, 200);

    // Unchanged ADR 0019 behaviour: the same body replayed against a moved revision is a
    // stale write, and the client adopts the order the 409 carries.
    const replay = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'stale_write');
    assert.equal(replay.body.current_revision, first.body.revision);

    // And a keyless edit against the CURRENT revision still lands.
    const next = await call(order.id, '', {
      method: 'PATCH', body: { notes: 'Keyless again', revision: first.body.revision },
    });
    assert.equal(next.status, 200);
    assert.equal((await storedOrder(order.id)).notes, 'Keyless again');
  });

  it('keeps an items edit exactly once, stock included', async () => {
    const order = await createOrder();
    const dispatched = await call(order.id, '/status', {
      body: { status: 'in_transit', expected_status: 'pending', revision: order.revision },
    });
    assert.equal(dispatched.status, 200);

    const beforeStock = await stockOf();
    const key = nextKey();
    const body = {
      items: [{ product_id: productId, quantity: 5, unit_price: 100 }],
      revision: dispatched.body.revision,
      request_key: key,
    };

    const first = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(first.status, 200);
    const afterFirstStock = await stockOf();
    assert.equal(afterFirstStock, beforeStock - 3, '2 cases out became 5 — three more off the shelf');

    const replay = await call(order.id, '', { method: 'PATCH', body });
    assert.equal(replay.status, 200);
    assert.equal(await stockOf(), afterFirstStock, 'the replay must not reconcile stock again');
    assert.equal((await storedOrder(order.id)).revision, first.body.revision);

    const { rows: items } = await db.query(
      'SELECT quantity FROM order_items WHERE order_id = $1', [order.id]
    );
    assert.equal(items.length, 1);
    assert.equal(Number(items[0].quantity), 5);
  });

  it('keeps an adjustment write exactly once', async () => {
    const order = await createOrder();
    const key = nextKey();
    const body = {
      adjustment: -25, adjustment_reason: 'Agreed discount',
      revision: order.revision, request_key: key,
    };

    const first = await call(order.id, '/adjustment', { method: 'PATCH', body });
    assert.equal(first.status, 200);

    const replay = await call(order.id, '/adjustment', { method: 'PATCH', body });
    assert.equal(replay.status, 200);

    const stored = await storedOrder(order.id);
    assert.equal(Number(stored.adjustment), -25);
    assert.equal(stored.revision, first.body.revision, 'no second adjustment write');
    assert.equal(await activityCount(order.id, 'adjusted'), 1);
  });

  it('keeps a status transition exactly once, and never strands the outbox record on a 422', async () => {
    const order = await createOrder();
    const beforeStock = await stockOf();
    const key = nextKey();
    const body = {
      status: 'in_transit', expected_status: 'pending',
      revision: order.revision, request_key: key,
    };

    const first = await call(order.id, '/status', { body });
    assert.equal(first.status, 200);
    assert.equal(await stockOf(), beforeStock - 2);

    // The outbox re-sends the same record after a lost response. Without the key the
    // state machine answers 422 ("cannot go pending → in_transit", it is already
    // in_transit) and the record lands in the needs-attention list for a write that
    // actually succeeded.
    const replay = await call(order.id, '/status', { body });
    assert.equal(replay.status, 200);

    const stored = await storedOrder(order.id);
    assert.equal(stored.status, 'in_transit');
    assert.equal(stored.revision, first.body.revision);
    assert.equal(await stockOf(), beforeStock - 2, 'stock deducted once');
    assert.equal(await activityCount(order.id, 'status_changed'), 1);
  });

  it('keeps a close exactly once even though the order is no longer completed', async () => {
    const order = await createOrder();
    const dispatched = await call(order.id, '/status', {
      body: { status: 'in_transit', expected_status: 'pending', revision: order.revision },
    });
    const delivered = await call(order.id, '/status', {
      body: { status: 'completed', expected_status: 'in_transit', revision: dispatched.body.revision },
    });
    assert.equal(delivered.status, 200);

    const { rows: [item] } = await db.query(
      'SELECT id FROM order_items WHERE order_id = $1', [order.id]
    );
    const key = nextKey();
    const body = { items: [{ id: item.id, bottles_returned: 3 }], revision: delivered.body.revision, request_key: key };

    const first = await call(order.id, '/close', { body });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'done');

    const replay = await call(order.id, '/close', { body });
    assert.equal(replay.status, 200, 'a replayed close is answered, not refused for being already done');
    const stored = await storedOrder(order.id);
    assert.equal(stored.status, 'done');
    assert.equal(stored.revision, first.body.revision);
    assert.equal(await activityCount(order.id, 'closed'), 1);
  });

  it('keeps a receipt-print record exactly once while staying unguarded by revision', async () => {
    const order = await createOrder();
    const key = nextKey();
    const body = { phase: 'pending', request_key: key };

    const first = await call(order.id, '/receipt-printed', { body });
    assert.equal(first.status, 200);
    assert.ok(first.body.pending_receipt_printed_at);

    const replay = await call(order.id, '/receipt-printed', { body });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.pending_receipt_printed_at, first.body.pending_receipt_printed_at);
    assert.equal((await storedOrder(order.id)).revision, first.body.revision);
    assert.equal(await activityCount(order.id, 'receipt_printed'), 1);

    // Still additive: no revision is required, exactly as ADR 0019 left it.
    const unguarded = await call(order.id, '/receipt-printed', { body: { phase: 'delivered' } });
    assert.equal(unguarded.status, 200);
    assert.ok(unguarded.body.delivered_receipt_printed_at);
  });

  it('resolves two overlapping retries of one aborted save into a single write', async () => {
    const order = await createOrder();
    const key = nextKey();
    const body = { notes: 'Two retries at once', revision: order.revision, request_key: key };

    const results = await Promise.all([
      call(order.id, '', { method: 'PATCH', body }),
      call(order.id, '', { method: 'PATCH', body }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);

    const stored = await storedOrder(order.id);
    assert.equal(stored.notes, 'Two retries at once');
    assert.equal(
      BigInt(stored.revision), BigInt(order.revision) + 1n,
      'one revision bump across both attempts'
    );
    assert.equal(await activityCount(order.id, 'edited'), 1);
    assert.deepEqual(results.map((r) => r.body.revision), [stored.revision, stored.revision]);
  });

  it('refuses a key already spent on a different order rather than answering with the wrong one', async () => {
    const first = await createOrder();
    const second = await createOrder();
    const key = nextKey();

    const ok = await call(first.id, '', {
      method: 'PATCH', body: { notes: 'Mine', revision: first.revision, request_key: key },
    });
    assert.equal(ok.status, 200);

    const misuse = await call(second.id, '', {
      method: 'PATCH', body: { notes: 'Not mine', revision: second.revision, request_key: key },
    });
    assert.equal(misuse.status, 409);
    assert.equal(misuse.body.code, 'request_key_reused');
    assert.equal((await storedOrder(second.id)).notes, null, 'the other order is untouched');
    assert.equal((await storedOrder(second.id)).revision, second.revision);
  });

  it('refuses a malformed key with a 400 and writes nothing', async () => {
    const order = await createOrder();
    const bad = await call(order.id, '', {
      method: 'PATCH',
      body: { notes: 'Should not land', revision: order.revision, request_key: 'has spaces and #' },
    });
    assert.equal(bad.status, 400);
    const stored = await storedOrder(order.id);
    assert.equal(stored.notes, null);
    assert.equal(stored.revision, order.revision);
  });

  it('leaves a draft autosave keyable without requiring a revision', async () => {
    const draft = await createOrder('draft');
    const key = nextKey();
    const body = { notes: 'Draft autosave', customer_id: customerId, request_key: key };

    const first = await call(draft.id, '', { method: 'PATCH', body });
    assert.equal(first.status, 200);
    const replay = await call(draft.id, '', { method: 'PATCH', body });
    assert.equal(replay.status, 200);

    const stored = await storedOrder(draft.id);
    assert.equal(stored.notes, 'Draft autosave');
    assert.equal(stored.revision, first.body.revision, 'the replayed autosave wrote nothing');
  });
});
