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

// Edit Order → Save Changes: the transaction's SHAPE, not just its result.
//
// The production API is ~200ms from the Sydney database and the app's write budget is a
// hard, correctly-non-retried 5 seconds. `PATCH /orders/:id` used to spend three round
// trips per product moved and one per line written, so a perfectly ordinary ten-line edit
// of a dispatched order cost sixty-odd sequential queries — twelve seconds of pure
// latency, and a timeout the operator experienced as "Save Changes does nothing".
//
// Batching that is only worth anything if the edit is still exactly as correct, so this
// suite pins both halves:
//
//   • the cost is bounded and does NOT grow with the number of lines or products, and the
//     whole edit still lands inside the budget under simulated per-query latency;
//   • stock reconciliation, audit rows, totals, bottle-return carry-back, packer-order
//     sorting, personnel and the draft-only field rules all behave exactly as before.
//
// The ceilings below are the assertions that fail if someone reintroduces a per-item or
// per-product loop. Measured on this fixture: a 12-line dispatched edit is 15 queries
// batched and was 67 sequential, and the same edit at a simulated 40ms per query runs in
// ~0.6s rather than ~2.6s.
describe('Order edit stays inside the write budget (batched PATCH transaction)', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let testCustomerId;
  let altCustomerId;
  let driverA;
  let driverB;

  // ── query instrumentation ────────────────────────────────────────────────
  // Everything is counted at ONE level: the pooled client. Clients are handed back to the
  // pool and checked out again, hence the WeakSet — wrap each real client exactly once, or
  // a re-checkout double-counts. `db.query` is re-pointed through the same wrapped client
  // (which is all pool.query does internally) so a pool query is recorded once, not twice.
  const realConnect = db.connect;
  const realQuery = db.query;
  const wrappedClients = new WeakSet();
  let counting = false;
  let recorded = [];
  let perQueryDelayMs = 0;

  function record(text) {
    if (!counting) return;
    recorded.push(typeof text === 'string' ? text : (text && text.text) || '');
  }

  const stall = () =>
    perQueryDelayMs ? new Promise((r) => setTimeout(r, perQueryDelayMs)) : null;

  db.connect = async () => {
    const client = await realConnect();
    if (!wrappedClients.has(client)) {
      wrappedClients.add(client);
      const originalQuery = client.query.bind(client);
      client.query = async (...args) => {
        record(args[0]);
        await stall();
        return originalQuery(...args);
      };
    }
    return client;
  };

  db.query = async (text, params) => {
    const client = await db.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  };

  // Run `fn` with query recording on; returns { statements, count, ms }.
  async function measure(fn, { delayMs = 0 } = {}) {
    recorded = [];
    perQueryDelayMs = delayMs;
    counting = true;
    const started = Date.now();
    try {
      await fn();
    } finally {
      counting = false;
      perQueryDelayMs = 0;
    }
    return { statements: recorded.slice(), count: recorded.length, ms: Date.now() - started };
  }

  before(async () => {
    let { rows: [user] } = await realQuery(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await realQuery(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-editbatch@leyblestore.com', 'dummyhash', 'Edit Batch Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    testUserId = user.id;

    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await realQuery(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('TEST_EDITBATCH Customer', 'regular', '1 Batch Road', '09170000001')
       RETURNING id`
    );
    testCustomerId = customer.id;

    const { rows: [alt] } = await realQuery(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('TEST_EDITBATCH Customer Alt', 'regular', '2 Batch Road', '09170000002')
       RETURNING id`
    );
    altCustomerId = alt.id;

    const { rows: people } = await realQuery(
      `INSERT INTO personnel (full_name, remarks, phone)
       VALUES ('TEST_EDITBATCH Driver A', 'driver', '09170000003'),
              ('TEST_EDITBATCH Driver B', 'helper', '09170000004')
       RETURNING id, full_name`
    );
    [driverA, driverB] = people;

    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1/orders`;
  });

  after(async () => {
    counting = false;
    perQueryDelayMs = 0;
    db.query = realQuery;
    db.connect = realConnect;

    if (server) await new Promise((resolve) => server.close(resolve));

    const customerIds = [testCustomerId, altCustomerId].filter(Boolean);
    if (customerIds.length) {
      await realQuery(
        `DELETE FROM inventory_audit_logs
          WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'TEST_EDITBATCH_%')
             OR related_order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await realQuery(
        `DELETE FROM order_items
          WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await realQuery(
        `DELETE FROM order_personnel
          WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await realQuery(
        `DELETE FROM activity_logs
          WHERE entity_type = 'order'
            AND entity_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await realQuery('DELETE FROM orders WHERE customer_id = ANY($1::int[])', [customerIds]);
      await realQuery('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds]);
    }
    await realQuery("DELETE FROM products WHERE name LIKE 'TEST_EDITBATCH_%'");
    await realQuery("DELETE FROM personnel WHERE full_name LIKE 'TEST_EDITBATCH %'");
  });

  // ── fixtures ─────────────────────────────────────────────────────────────

  let productSeq = 0;
  async function createProduct(stock = 500, price = 100, opts = {}) {
    productSeq += 1;
    const { rows: [product] } = await realQuery(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee,
                             current_stock, is_active, units_per_case, requires_bottle_return)
       VALUES ($1, $2, 'case', $3, $4, $5, $6, TRUE, $7, $8)
       RETURNING *`,
      [
        `TEST_EDITBATCH_P${String(productSeq).padStart(3, '0')}`,
        opts.category || 'Beer',
        `SKU_EB_${Date.now()}_${productSeq}`,
        price,
        opts.depositFee || 0,
        stock,
        opts.unitsPerCase || 1,
        Boolean(opts.requiresBottleReturn),
      ]
    );
    return product;
  }

  async function stockOf(productId) {
    const { rows: [p] } = await realQuery(
      'SELECT current_stock FROM products WHERE id = $1', [productId]
    );
    return Number(p.current_stock);
  }

  async function auditRows(orderId) {
    const { rows } = await realQuery(
      'SELECT * FROM inventory_audit_logs WHERE related_order_id = $1 ORDER BY id',
      [orderId]
    );
    return rows;
  }

  // The response body can only be read once, so the failure message reads it lazily —
  // an inline `await res.text()` as an assert message consumes it on the happy path too.
  async function expectStatus(res, status) {
    if (res.status !== status) {
      assert.fail(`expected ${status}, got ${res.status}: ${await res.text()}`);
    }
  }

  function api(endpoint, options = {}) {
    return fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(options.headers || {}),
      },
    });
  }

  async function createOrder(body) {
    const res = await api('', { method: 'POST', body: JSON.stringify(body) });
    await expectStatus(res, 201);
    return res.json();
  }

  async function setStatus(orderId, status) {
    const res = await api(`/${orderId}/status`, {
      method: 'POST', body: JSON.stringify({ status }),
    });
    await expectStatus(res, 200);
    return res.json();
  }

  // A dispatched delivery: stock is OUT, so editing it takes the reconciliation path —
  // the most expensive shape the edit screen can produce.
  async function dispatchedOrderWith(lineCount) {
    const products = [];
    for (let i = 0; i < lineCount; i += 1) products.push(await createProduct(500, 100 + i));
    const order = await createOrder({
      customer_id: testCustomerId,
      order_type: 'delivery',
      items: products.map((p, i) => ({
        product_id: p.id, quantity: 2 + i, unit_price: 100 + i,
      })),
    });
    await setStatus(order.id, 'in_transit');
    return { order, products };
  }

  // ── 1. the cost of an edit ───────────────────────────────────────────────

  describe('1. The transaction no longer grows with the order', () => {
    it('costs the same bounded number of queries for 3 lines and for 12', async () => {
      const small = await dispatchedOrderWith(3);
      const large = await dispatchedOrderWith(12);

      const editBody = ({ products }) => JSON.stringify({
        notes: 'edited',
        items: products.map((p, i) => ({
          product_id: p.id, quantity: 5 + i, unit_price: 120 + i,
        })),
        personnel: [{ id: driverA.id, role: 'Driver' }, { id: driverB.id, role: 'Helper' }],
      });

      const smallRun = await measure(async () => {
        const res = await api(`/${small.order.id}`, { method: 'PATCH', body: editBody(small) });
        await expectStatus(res, 200);
      });
      const largeRun = await measure(async () => {
        const res = await api(`/${large.order.id}`, { method: 'PATCH', body: editBody(large) });
        await expectStatus(res, 200);
      });

      // The whole point: four times the lines and four times the products moved, same
      // number of database round trips. A per-item or per-product loop coming back would
      // put ~27 extra queries on the 12-line edit alone.
      assert.equal(
        largeRun.count, smallRun.count,
        `edit cost grew with the order: 3 lines took ${smallRun.count} queries, ` +
        `12 lines took ${largeRun.count}\n${largeRun.statements.join('\n---\n')}`
      );

      // Ceiling, so the shape cannot quietly drift back upwards either. Measured against
      // this fixture: 15 queries for both the 3-line and the 12-line edit (auth check,
      // BEGIN/COMMIT, the batched writes, and the three reads behind the response), where
      // the sequential shape it replaced cost 31 and 67 respectively.
      assert.ok(
        largeRun.count <= 16,
        `12-line edit took ${largeRun.count} queries (budget 16):\n` +
        largeRun.statements.join('\n---\n')
      );

      // And no statement in it is issued more than a handful of times — a per-product
      // "SELECT current_stock … FOR UPDATE" would show up twelve times over.
      const perStatement = new Map();
      for (const sql of largeRun.statements) {
        const key = sql.replace(/\s+/g, ' ').trim().slice(0, 60);
        perStatement.set(key, (perStatement.get(key) || 0) + 1);
      }
      for (const [sql, times] of perStatement) {
        assert.ok(times <= 2, `statement issued ${times}× in one edit: ${sql}`);
      }
    });

    it('completes a 12-line dispatched edit well inside the write budget at 40ms/query',
      async () => {
        const { order, products } = await dispatchedOrderWith(12);

        // 40ms per query is a fifth of the real production round trip, chosen so the test
        // stays quick; at this latency the batched edit is ~0.6s and the sequential shape
        // it replaced would be ~2.6s. The assertion is the ratio, not the absolute: a
        // regression to per-item queries blows straight through it.
        const run = await measure(async () => {
          const res = await api(`/${order.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              items: products.map((p, i) => ({
                product_id: p.id, quantity: 4, unit_price: 130 + i,
              })),
              personnel: [{ id: driverA.id, role: 'Driver' }],
            }),
          });
          await expectStatus(res, 200);
        }, { delayMs: 40 });

        assert.ok(
          run.ms < 1200,
          `edit took ${run.ms}ms at 40ms/query over ${run.count} queries (budget 1200ms)`
        );
      });
  });

  // ── 2. the edit is still correct ─────────────────────────────────────────

  describe('2. Stock, audit and totals still reconcile exactly', () => {
    it('reconciles every product in one batched movement, with one audit row each',
      async () => {
        const keep    = await createProduct(500, 100);   // quantity goes up
        const shrink  = await createProduct(500, 100);   // quantity goes down
        const dropped = await createProduct(500, 100);   // removed from the order
        const added   = await createProduct(500, 100);   // new line

        const order = await createOrder({
          customer_id: testCustomerId,
          order_type: 'delivery',
          items: [
            { product_id: keep.id,    quantity: 4, unit_price: 100 },
            { product_id: shrink.id,  quantity: 6, unit_price: 100 },
            { product_id: dropped.id, quantity: 3, unit_price: 100 },
          ],
        });
        await setStatus(order.id, 'in_transit');

        assert.equal(await stockOf(keep.id), 496);
        assert.equal(await stockOf(shrink.id), 494);
        assert.equal(await stockOf(dropped.id), 497);
        assert.equal(await stockOf(added.id), 500);

        const before = (await auditRows(order.id)).length;

        const res = await api(`/${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            items: [
              { product_id: keep.id,   quantity: 10, unit_price: 100 },
              { product_id: shrink.id, quantity: 1,  unit_price: 100 },
              { product_id: added.id,  quantity: 2,  unit_price: 100 },
            ],
          }),
        });
        await expectStatus(res, 200);

        // old − new per product: keep −6 more out, shrink +5 back, dropped +3 back,
        // added −2 out. Stock is allowed to be whatever it is; it must be exactly this.
        assert.equal(await stockOf(keep.id), 490);
        assert.equal(await stockOf(shrink.id), 499);
        assert.equal(await stockOf(dropped.id), 500);
        assert.equal(await stockOf(added.id), 498);

        const after = await auditRows(order.id);
        const fromEdit = after.slice(before);
        assert.equal(fromEdit.length, 4, 'one audit row per moved product');
        for (const row of fromEdit) {
          assert.equal(row.action_type, 'order_edit');
          assert.equal(row.field_changed, 'current_stock');
          assert.equal(row.performed_by, testUserId);
          assert.equal(row.related_order_id, order.id);
          // previous/new value text is still written, and still agrees with the delta.
          assert.equal(
            Number(row.new_value) - Number(row.previous_value),
            Number(row.delta)
          );
        }
        // Ascending product id — the lock order that keeps concurrent edits from
        // deadlocking, still visible in the rows they wrote.
        const ids = fromEdit.map((r) => r.product_id);
        assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

        const body = await res.json();
        assert.equal(Number(body.total_amount), 10 * 100 + 1 * 100 + 2 * 100);
      });

    it('leaves stock alone when the order is not dispatched, and when it is cancelled',
      async () => {
        const product = await createProduct(500, 100);
        const pending = await createOrder({
          customer_id: testCustomerId,
          order_type: 'delivery',
          items: [{ product_id: product.id, quantity: 5, unit_price: 100 }],
        });

        const res = await api(`/${pending.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ items: [{ product_id: product.id, quantity: 50, unit_price: 100 }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(await stockOf(product.id), 500, 'a pending edit moves no stock');
        assert.equal((await auditRows(pending.id)).length, 0);

        await setStatus(pending.id, 'cancelled');
        assert.equal(await stockOf(product.id), 500);

        const res2 = await api(`/${pending.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] }),
        });
        assert.equal(res2.status, 200);
        assert.equal(await stockOf(product.id), 500, 'a cancelled order never moves stock');
      });

    it('carries bottle returns across an edit of a closed order', async () => {
      const product = await createProduct(500, 100, {
        depositFee: 5, unitsPerCase: 12, requiresBottleReturn: true,
      });

      const order = await createOrder({
        customer_id: testCustomerId,
        order_type: 'delivery',
        items: [{
          product_id: product.id, quantity: 4, unit_price: 100,
          unit_deposit_fee: 5, units_per_case: 12,
        }],
      });
      await setStatus(order.id, 'in_transit');
      await setStatus(order.id, 'completed');

      const detail = await (await api(`/${order.id}`)).json();
      const closeRes = await api(`/${order.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ id: detail.items[0].id, bottles_returned: 30 }] }),
      });
      await expectStatus(closeRes, 200);
      const closed = await closeRes.json();
      assert.equal(Number(closed.items[0].bottles_returned), 30);
      // 4 × 100 goods + (48 − 30) un-returned bottles × ₱5 deposit
      assert.equal(Number(closed.total_amount), 400 + 18 * 5);

      // Fixing the price on a closed order must not wipe the returns and re-inflate it.
      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [{
            product_id: product.id, quantity: 4, unit_price: 110,
            unit_deposit_fee: 5, units_per_case: 12,
          }],
        }),
      });
      await expectStatus(res, 200);
      const edited = await res.json();
      assert.equal(Number(edited.items[0].bottles_returned), 30);
      assert.equal(Number(edited.total_amount), 440 + 18 * 5);

      // And the carry-back is clamped by what the new line can hold: dropping to one
      // case leaves only 12 bottles to return against.
      const res2 = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [{
            product_id: product.id, quantity: 1, unit_price: 110,
            unit_deposit_fee: 5, units_per_case: 12,
          }],
        }),
      });
      await expectStatus(res2, 200);
      const shrunk = await res2.json();
      assert.equal(Number(shrunk.items[0].bottles_returned), 12);
      assert.equal(Number(shrunk.total_amount), 110);
    });

    it('writes the lines in packer (category, then name) order', async () => {
      const soda  = await createProduct(500, 100, { category: 'Soft Drinks' });
      const beer  = await createProduct(500, 100, { category: 'Beer' });
      const water = await createProduct(500, 100, { category: 'Water' });

      const order = await createOrder({
        customer_id: testCustomerId,
        items: [{ product_id: soda.id, quantity: 1, unit_price: 100 }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: water.id, quantity: 1, unit_price: 100 },
            { product_id: soda.id,  quantity: 1, unit_price: 100 },
            { product_id: beer.id,  quantity: 1, unit_price: 100 },
          ],
        }),
      });
      await expectStatus(res, 200);
      const body = await res.json();
      assert.deepEqual(
        body.items.map((i) => i.category),
        ['Beer', 'Soft Drinks', 'Water']
      );
    });
  });

  // ── 3. everything else the route promised ────────────────────────────────

  describe('3. Metadata, personnel and the draft-only fields are unchanged', () => {
    it('edits notes alone without touching items or the total', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        notes: 'first',
        items: [{ product_id: product.id, quantity: 3, unit_price: 100 }],
      });

      const run = await measure(async () => {
        const res = await api(`/${order.id}`, {
          method: 'PATCH', body: JSON.stringify({ notes: 'second' }),
        });
        await expectStatus(res, 200);
        const body = await res.json();
        assert.equal(body.notes, 'second');
        assert.equal(body.items.length, 1);
        assert.equal(Number(body.items[0].quantity), 3);
        assert.equal(Number(body.total_amount), 300);
      });
      assert.ok(run.count <= 9, `notes-only edit took ${run.count} queries`);
    });

    it('keeps notes when the field is omitted', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        notes: 'keep me',
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ product_id: product.id, quantity: 2, unit_price: 100 }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.notes, 'keep me');
      assert.equal(Number(body.total_amount), 200);
    });

    it('replaces personnel, de-duplicating a repeated person to the last role given',
      async () => {
        const product = await createProduct(500, 100);
        const order = await createOrder({
          customer_id: testCustomerId,
          items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
          personnel: [{ id: driverA.id, role: 'Driver' }],
        });

        const res = await api(`/${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            personnel: [
              { id: driverB.id, role: 'Helper' },
              { id: driverB.id, role: 'Loader' },
            ],
          }),
        });
        await expectStatus(res, 200);
        const body = await res.json();
        assert.equal(body.personnel.length, 1);
        assert.equal(body.personnel[0].personnel_id, driverB.id);
        assert.equal(body.personnel[0].role, 'Loader');
      });

    it('clears personnel when handed an empty list', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        personnel: [{ id: driverA.id, role: 'Driver' }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH', body: JSON.stringify({ personnel: [] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).personnel, []);
    });

    it('still refuses two Drivers on one order, and rolls the whole edit back', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        notes: 'untouched',
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          notes: 'should not stick',
          items: [{ product_id: product.id, quantity: 9, unit_price: 100 }],
          personnel: [
            { id: driverA.id, role: 'Driver' },
            { id: driverB.id, role: 'Driver' },
          ],
        }),
      });
      assert.equal(res.status, 400);

      const after = await (await api(`/${order.id}`)).json();
      assert.equal(after.notes, 'untouched');
      assert.equal(Number(after.items[0].quantity), 1);
      assert.equal(Number(after.total_amount), 100);
    });

    it('still refuses a negative price and leaves the lines intact', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        items: [{ product_id: product.id, quantity: 2, unit_price: 100 }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [{ product_id: product.id, quantity: 2, unit_price: -5 }],
        }),
      });
      assert.equal(res.status, 400);

      const after = await (await api(`/${order.id}`)).json();
      assert.equal(after.items.length, 1);
      assert.equal(Number(after.items[0].unit_price), 100);
    });

    it('lets a draft change customer and order type, and a live order not', async () => {
      const product = await createProduct(500, 100);
      const draft = await createOrder({
        customer_id: testCustomerId,
        status: 'draft',
        order_type: 'delivery',
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      });

      const res = await api(`/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          customer_id: altCustomerId,
          order_type: 'pickup',
          items: [{ product_id: product.id, quantity: 2, unit_price: 100 }],
        }),
      });
      await expectStatus(res, 200);
      const editedDraft = await res.json();
      assert.equal(editedDraft.customer_id, altCustomerId);
      assert.equal(editedDraft.order_type, 'pickup');

      const live = await createOrder({
        customer_id: testCustomerId,
        order_type: 'delivery',
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      });
      const res2 = await api(`/${live.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          customer_id: altCustomerId,
          order_type: 'pickup',
          items: [{ product_id: product.id, quantity: 2, unit_price: 100 }],
        }),
      });
      await expectStatus(res2, 200);
      const editedLive = await res2.json();
      assert.equal(editedLive.customer_id, testCustomerId, 'a live order keeps its customer');
      assert.equal(editedLive.order_type, 'delivery', 'a live order keeps its type');
    });

    it('empties an order when handed an empty item list', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        items: [{ product_id: product.id, quantity: 3, unit_price: 100 }],
      });
      await setStatus(order.id, 'in_transit');
      assert.equal(await stockOf(product.id), 497);

      const res = await api(`/${order.id}`, {
        method: 'PATCH', body: JSON.stringify({ items: [] }),
      });
      await expectStatus(res, 200);
      const body = await res.json();
      assert.deepEqual(body.items, []);
      assert.equal(Number(body.total_amount), 0);
      assert.equal(await stockOf(product.id), 500, 'the dispatched goods come back');
    });

    it('records one activity entry naming what changed', async () => {
      const product = await createProduct(500, 100);
      const order = await createOrder({
        customer_id: testCustomerId,
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      });

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          notes: 'changed',
          items: [{ product_id: product.id, quantity: 2, unit_price: 100 }],
          personnel: [{ id: driverA.id, role: 'Driver' }],
        }),
      });
      assert.equal(res.status, 200);

      const { rows } = await realQuery(
        `SELECT * FROM activity_logs
          WHERE entity_type = 'order' AND entity_id = $1 AND action = 'edited'`,
        [order.id]
      );
      assert.equal(rows.length, 1);
      assert.match(rows[0].summary, /Notes updated/);
      assert.match(rows[0].summary, /Items replaced \(1 item\)/);
      assert.match(rows[0].summary, /Personnel updated/);
      assert.equal(rows[0].performed_by, testUserId);
    });
  });
});
