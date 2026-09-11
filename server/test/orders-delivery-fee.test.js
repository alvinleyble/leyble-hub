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

// docs/product/proposals/persistent-delivery-fee.md — orders.delivery_fee_charged.
// Decision 6: snapshotted from the customer's standing fee at creation. Decision 7:
// delivery orders only. Decision 8: overridable per order. Decision 14: charge-only.
describe('Persistent delivery fee — orders.delivery_fee_charged', () => {
  let server;
  let baseUrl;
  let authToken;
  let customerWithFeeId;
  let customerNoFeeId;
  let productId;

  before(async () => {
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-delfee-orders@leyblestore.com', 'dummyhash', 'Order Delivery Fee Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [withFee] } = await db.query(
      `INSERT INTO customers (name, customer_type, delivery_fee)
       VALUES ('TEST_DELFEE Customer With Fee', 'regular', 120.00)
       RETURNING id`
    );
    customerWithFeeId = withFee.id;

    const { rows: [noFee] } = await db.query(
      `INSERT INTO customers (name, customer_type)
       VALUES ('TEST_DELFEE Customer No Fee', 'regular')
       RETURNING id`
    );
    customerNoFeeId = noFee.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price,
                             current_stock, is_active, units_per_case)
       VALUES ('TEST_DELFEE_PRODUCT', 'Beer', 'case', $1, 100, 500, TRUE, 1)
       RETURNING id`,
      [`SKU_DELFEE_${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1/orders`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const customerIds = [customerWithFeeId, customerNoFeeId].filter(Boolean);
    if (customerIds.length) {
      await db.query(
        `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await db.query(
        `DELETE FROM activity_logs WHERE entity_type = 'order'
           AND entity_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
        [customerIds]
      );
      await db.query('DELETE FROM orders WHERE customer_id = ANY($1::int[])', [customerIds]);
      await db.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds]);
    }
    if (productId) await db.query('DELETE FROM products WHERE id = $1', [productId]);
  });

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

  async function expectStatus(res, status) {
    if (res.status !== status) {
      assert.fail(`expected ${status}, got ${res.status}: ${await res.text()}`);
    }
  }

  async function createOrder(body) {
    const res = await api('', { method: 'POST', body: JSON.stringify(body) });
    await expectStatus(res, 201);
    return res.json();
  }

  const items = () => [{ product_id: productId, quantity: 1, unit_price: 100 }];

  it('1. A delivery order snapshots the customer\'s standing fee (decision 6)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    assert.equal(Number(order.delivery_fee_charged), 120);
  });

  it('2. A delivery order for a customer with no standing fee gets none (decision 3)', async () => {
    const order = await createOrder({
      customer_id: customerNoFeeId, order_type: 'delivery', items: items(),
    });
    assert.equal(order.delivery_fee_charged, null);
  });

  it('3. A pickup order never carries a delivery fee, even for a customer with one (decision 7)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'pickup', items: items(),
    });
    assert.equal(order.delivery_fee_charged, null);
  });

  it('4. A pickup order ignores an explicit delivery_fee_charged override (decision 7)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'pickup', items: items(),
      delivery_fee_charged: 999,
    });
    assert.equal(order.delivery_fee_charged, null);
  });

  it('5. An explicit override on a delivery order wins over the customer\'s standing fee (decision 8)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
      delivery_fee_charged: 50,
    });
    assert.equal(Number(order.delivery_fee_charged), 50);
  });

  it('6. An explicit null waives the fee for this order without touching the customer\'s standing fee (decision 8)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
      delivery_fee_charged: null,
    });
    assert.equal(order.delivery_fee_charged, null);

    const customer = await db.query('SELECT delivery_fee FROM customers WHERE id = $1', [customerWithFeeId]);
    assert.equal(Number(customer.rows[0].delivery_fee), 120);
  });

  it('7. Rejects a negative delivery_fee_charged (decision 14)', async () => {
    const res = await api('', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
        delivery_fee_charged: -5,
      }),
    });
    assert.equal(res.status, 400);
  });

  it('8. A deliberately-configured ₱0.00 fee is preserved, not treated as unset (decision 4)', async () => {
    await db.query('UPDATE customers SET delivery_fee = 0 WHERE id = $1', [customerWithFeeId]);
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    assert.equal(Number(order.delivery_fee_charged), 0);
    await db.query('UPDATE customers SET delivery_fee = 120 WHERE id = $1', [customerWithFeeId]);
  });

  it('9. A later change to the customer\'s standing fee never touches an already-created order (decision 6)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    assert.equal(Number(order.delivery_fee_charged), 120);

    await db.query('UPDATE customers SET delivery_fee = 300 WHERE id = $1', [customerWithFeeId]);

    const res = await api(`/${order.id}`);
    const reloaded = await res.json();
    assert.equal(Number(reloaded.delivery_fee_charged), 120);
    await db.query('UPDATE customers SET delivery_fee = 120 WHERE id = $1', [customerWithFeeId]);
  });

  it('10. PATCH can override the fee on an existing order without touching order_type/items behavior (decision 8)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    const res = await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: items(), delivery_fee_charged: 80 }),
    });
    await expectStatus(res, 200);
    const updated = await res.json();
    assert.equal(Number(updated.delivery_fee_charged), 80);
  });

  it('11. PATCH with delivery_fee_charged omitted leaves the stored value unchanged (items branch)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    const res = await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: items() }),
    });
    await expectStatus(res, 200);
    const updated = await res.json();
    assert.equal(Number(updated.delivery_fee_charged), 120);
  });

  it('12. PATCH with delivery_fee_charged omitted leaves the stored value unchanged (no-items branch)', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    const res = await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'just a note' }),
    });
    await expectStatus(res, 200);
    const updated = await res.json();
    assert.equal(Number(updated.delivery_fee_charged), 120);
  });

  it('13. PATCH rejects a negative delivery_fee_charged and leaves the order untouched', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });
    const res = await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: items(), delivery_fee_charged: -1 }),
    });
    assert.equal(res.status, 400);

    const reloaded = await (await api(`/${order.id}`)).json();
    assert.equal(Number(reloaded.delivery_fee_charged), 120);
  });

  it('15. PATCH override/waive of the delivery fee is recorded in activity_logs', async () => {
    const order = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', items: items(),
    });

    await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: items(), delivery_fee_charged: 80 }),
    });
    let { rows } = await db.query(
      `SELECT summary FROM activity_logs WHERE entity_type = 'order' AND entity_id = $1
         ORDER BY id DESC LIMIT 1`,
      [order.id]
    );
    assert.match(rows[0].summary, /Delivery fee set to ₱80\.00/);

    await api(`/${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: items(), delivery_fee_charged: null }),
    });
    ({ rows } = await db.query(
      `SELECT summary FROM activity_logs WHERE entity_type = 'order' AND entity_id = $1
         ORDER BY id DESC LIMIT 1`,
      [order.id]
    ));
    assert.match(rows[0].summary, /Delivery fee waived/);
  });

  it('14. A draft switched from delivery to pickup via PATCH drops its charged fee (decision 7/11)', async () => {
    const draft = await createOrder({
      customer_id: customerWithFeeId, order_type: 'delivery', status: 'draft', items: [],
    });
    assert.equal(Number(draft.delivery_fee_charged), 120);

    const res = await api(`/${draft.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ order_type: 'pickup', delivery_fee_charged: 999 }),
    });
    await expectStatus(res, 200);
    const updated = await res.json();
    assert.equal(updated.order_type, 'pickup');
    assert.equal(updated.delivery_fee_charged, null);
  });
});
