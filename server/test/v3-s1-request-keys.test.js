// ADR 0017 #9, server half — the retry key, split off the receipt number.
//
// Until now the receipt number WAS the anti-duplicate key, and that made a duplicated
// receipt number silently destructive: the second sale was answered with the FIRST
// sale's stored order, the device cleared its outbox, and the sale vanished with
// nothing anywhere reporting it. What has to hold here:
//
//   * the same request_key twice is one order and a success (so retries stay safe);
//   * two different request_keys are two orders, even on one receipt number (so a
//     second sale can never be swallowed by an earlier one);
//   * a record carrying NO request_key still dedupes on the receipt number, because
//     an outbox record queued by a pre-039 build has to keep draining through ADR
//     0014's multi-day mixed-fleet window.
//
// The same three hold for supplier_deliveries, which shares the mechanism.
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
const incomingRoutes = require('../src/routes/incoming');
const { errorHandler } = require('../src/middleware/errorHandler');
const { normalizeRequestKey, REQUEST_KEY_MAX_LENGTH } = require('../src/lib/idempotency');

describe('ADR 0017 #9 — the retry key is separate from the receipt number', () => {
  let server;
  let baseUrl;
  let authToken;
  let customerId;
  let productId;
  const deliveryIds = [];

  before(async () => {
    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE profile_key = 'admin' LIMIT 1`
    );
    authToken = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, full_name: admin.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_S1RK_CUSTOMER', 'regular') RETURNING id`
    );
    customerId = customer.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('TEST_S1RK_PROD', 'Beer', 'case', $1, 100, 0, 500, TRUE) RETURNING id`,
      [`SKU_S1RK_${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use('/api/v1/incoming', incomingRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.query(
      `DELETE FROM inventory_audit_logs
        WHERE product_id = $1
           OR related_order_id IN (SELECT id FROM orders WHERE customer_id = $2)`,
      [productId, customerId]
    );
    await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
    await db.query('DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    if (deliveryIds.length) {
      await db.query('DELETE FROM supplier_delivery_items WHERE delivery_id = ANY($1::int[])', [deliveryIds]);
      await db.query('DELETE FROM supplier_deliveries WHERE id = ANY($1::int[])', [deliveryIds]);
    }
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await db.query('DELETE FROM products WHERE id = $1', [productId]);
  });

  function call(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(options.headers || {}),
      },
    });
  }

  // ADR 0016 caps the station component at this store's three slots, so tests vary
  // their SEQUENCE rather than their station to stay unique across re-runs against a
  // reused database.
  let sequenceSeed = 10000 + (Date.now() % 60000);
  const testReceipt = (slot = 1) => `${slot}-${String(++sequenceSeed).padStart(5, '0')}`;
  const testDeliveryRef = (slot = 1) => `${slot}-DEL-${String(++sequenceSeed).padStart(5, '0')}`;

  let keySeed = 0;
  const testKey = () => `rk_test_${Date.now().toString(16)}_${++keySeed}`;

  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

  const orderBody = (over = {}) => ({
    customer_id: customerId,
    items: [{ product_id: productId, quantity: 1, unit_price: 100 }],
    ...over,
  });

  const deliveryBody = (over = {}) => ({
    supplier_name: 'TEST_S1RK_SUPPLIER',
    items: [{ product_id: productId, quantity_received: 5, unit_cost: 80 }],
    ...over,
  });

  async function countOrdersWithKey(requestKey) {
    const { rows: [row] } = await db.query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE request_key = $1', [requestKey]
    );
    return row.n;
  }

  async function countOrdersOnReceipt(receipt) {
    const [station, sequence] = receipt.split('-');
    const { rows: [row] } = await db.query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE receipt_station = $1 AND receipt_sequence = $2',
      [Number(station), Number(sequence)]
    );
    return row.n;
  }

  // ── The retry, which must stay safe ───────────────────────────────────────

  describe('the same request_key sent twice', () => {
    it('stores one order and answers the resend with it', async () => {
      const requestKey = testKey();
      const body = orderBody({ receipt_number: testReceipt(1), request_key: requestKey });

      const first = await post('/orders', body);
      assert.equal(first.status, 201);
      const created = await first.json();
      assert.equal(created.request_key, requestKey);

      // The response to the first attempt was lost on the way back; the outbox retries.
      const second = await post('/orders', body);
      assert.equal(second.status, 200, 'a replay is a success, never a 409 — the device must clear it');
      assert.equal((await second.json()).id, created.id);

      assert.equal(await countOrdersWithKey(requestKey), 1, 'one sale, one row');
    });

    it('answers the resend even after the order has moved on', async () => {
      const requestKey = testKey();
      const body = orderBody({
        receipt_number: testReceipt(2), request_key: requestKey,
        items: [{ product_id: productId, quantity: 3, unit_price: 100 }],
      });

      const created = await (await post('/orders', body)).json();
      await post(`/orders/${created.id}/status`, { status: 'in_transit' });

      const replay = await post('/orders', body);
      assert.equal(replay.status, 200);
      const replayed = await replay.json();
      assert.equal(replayed.id, created.id);
      assert.equal(replayed.status, 'in_transit', 'the stored order as it is now, not a fresh one');
      assert.equal(await countOrdersWithKey(requestKey), 1);
    });

    it('survives two drain attempts racing each other', async () => {
      const requestKey = testKey();
      const body = orderBody({ receipt_number: testReceipt(3), request_key: requestKey });

      const [a, b] = await Promise.all([post('/orders', body), post('/orders', body)]);
      assert.ok([200, 201].includes(a.status), `unexpected ${a.status}`);
      assert.ok([200, 201].includes(b.status), `unexpected ${b.status}`);
      assert.equal((await a.json()).id, (await b.json()).id);

      assert.equal(await countOrdersWithKey(requestKey), 1,
        'the unique index catches the loser and it is answered with the winner’s row');
    });
  });

  // ── The duplicate, which must stop being destructive ──────────────────────

  describe('two different request_keys', () => {
    it('are two orders', async () => {
      const first = await (await post('/orders', orderBody({
        receipt_number: testReceipt(1), request_key: testKey(),
      }))).json();
      const second = await (await post('/orders', orderBody({
        receipt_number: testReceipt(1), request_key: testKey(),
      }))).json();

      assert.notEqual(first.id, second.id);
    });

    it('sharing one receipt number are refused, not silently collapsed into the first', async () => {
      const receipt = testReceipt(2);
      const first = await post('/orders', orderBody({ receipt_number: receipt, request_key: testKey() }));
      assert.equal(first.status, 201);
      const firstOrder = await first.json();

      // A genuinely different sale that has ended up wearing the same number. Before
      // ADR 0017 #9 this returned firstOrder with a 200 — the device cleared it and
      // the second sale was gone. Now it is refused with a reason a human can act on.
      const second = await post('/orders', orderBody({
        receipt_number: receipt, request_key: testKey(),
        items: [{ product_id: productId, quantity: 7, unit_price: 250 }],
      }));

      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /already used by a different order/);
      assert.notEqual(second.status, 200, 'never answered with the earlier sale');

      assert.equal(await countOrdersOnReceipt(receipt), 1,
        'the receipt number keeps its uniqueness — this slice changes nothing about that');

      // And the first sale is untouched by the refusal.
      const stored = await (await call(`/orders/${firstOrder.id}`)).json();
      assert.equal(stored.total_amount, firstOrder.total_amount);
    });
  });

  // ── The mixed-fleet window (ADR 0014) ─────────────────────────────────────

  describe('a record with no request_key', () => {
    it('still dedupes on the receipt number, exactly as before', async () => {
      const receipt = testReceipt(3);
      const body = orderBody({ receipt_number: receipt });

      const first = await post('/orders', body);
      assert.equal(first.status, 201);
      const second = await post('/orders', body);
      assert.equal(second.status, 200);
      assert.equal((await second.json()).id, (await first.json()).id);

      assert.equal(await countOrdersOnReceipt(receipt), 1);
    });

    it('with no receipt number either, behaves exactly as a connected client always has', async () => {
      const res = await post('/orders', orderBody());
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, null);
      assert.equal(order.request_key, null);
    });
  });

  // ── A malformed key is refused, never ignored ─────────────────────────────

  describe('validation', () => {
    it('refuses a malformed request_key rather than silently dropping the protection', async () => {
      const res = await post('/orders', orderBody({ request_key: 'has spaces and £' }));
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /request_key/);
    });

    it('refuses a request_key too long for the column', async () => {
      const res = await post('/orders', orderBody({ request_key: 'a'.repeat(REQUEST_KEY_MAX_LENGTH + 1) }));
      assert.equal(res.status, 400);
    });

    it('normalizeRequestKey treats absence as absence, not as an error', () => {
      assert.equal(normalizeRequestKey(undefined), null);
      assert.equal(normalizeRequestKey(null), null);
      assert.equal(normalizeRequestKey(''), null);
      assert.equal(normalizeRequestKey('  rk_abc123  '), 'rk_abc123');
    });
  });

  // ── The second table: the mechanism is still table-agnostic ───────────────

  describe('supplier deliveries share the mechanism', () => {
    it('a resent request_key is one delivery and one restock', async () => {
      const requestKey = testKey();
      const body = deliveryBody({ delivery_ref: testDeliveryRef(1), request_key: requestKey });

      const { rows: [before] } = await db.query('SELECT current_stock FROM products WHERE id = $1', [productId]);

      const first = await post('/incoming', body);
      assert.equal(first.status, 201);
      const created = await first.json();
      deliveryIds.push(created.id);

      const second = await post('/incoming', body);
      assert.equal(second.status, 200);
      assert.equal((await second.json()).id, created.id);

      const { rows: [after] } = await db.query('SELECT current_stock FROM products WHERE id = $1', [productId]);
      assert.equal(Number(after.current_stock) - Number(before.current_stock), 5,
        'one truckload of stock, not two');
    });

    it('a different request_key on a stored delivery_ref is refused, not answered with the stored one', async () => {
      const ref = testDeliveryRef(2);
      const first = await post('/incoming', deliveryBody({ delivery_ref: ref, request_key: testKey() }));
      assert.equal(first.status, 201);
      deliveryIds.push((await first.json()).id);

      const second = await post('/incoming', deliveryBody({ delivery_ref: ref, request_key: testKey() }));
      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /already used by a different delivery/);
    });

    it('a delivery with no request_key still dedupes on its reference', async () => {
      const ref = testDeliveryRef(3);
      const body = deliveryBody({ delivery_ref: ref });

      const first = await post('/incoming', body);
      assert.equal(first.status, 201);
      deliveryIds.push((await first.json()).id);

      const second = await post('/incoming', body);
      assert.equal(second.status, 200);
    });
  });
});
