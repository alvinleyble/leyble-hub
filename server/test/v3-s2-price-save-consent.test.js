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
const customerRoutes = require('../src/routes/customers');
const { errorHandler } = require('../src/middleware/errorHandler');

// A saved price is written ONLY by the explicit "Save Custom Price?" prompt.
//
// `is_price_overridden` on an order line means "this price was hand-typed on this order" —
// it does not mean "this is the customer's standing rate". Order-save used to write a
// customer_product_prices row on that flag alone, before the operator was even asked, so
// answering **No** to the prompt changed nothing: a one-off "he gets ₱600 today" became
// permanent, and there is no delete endpoint to take it back. These tests pin the two
// halves of the fix — No leaves zero rows, Yes leaves exactly one.
describe('Saved prices need explicit consent (blast-radius R1)', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let customerId;
  let productId;

  const api = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const savedPriceCount = async () => {
    const { rows: [row] } = await db.query(
      'SELECT COUNT(*)::int AS n FROM customer_product_prices WHERE customer_id = $1',
      [customerId]
    );
    return row.n;
  };

  before(async () => {
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-price-consent@leyblestore.com', 'dummyhash', 'Price Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    testUserId = user.id;
    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('TEST_PRICE_CONSENT Customer', 'regular', '1 Test St', '09170000000')
       RETURNING id`
    );
    customerId = customer.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, sku, category, unit, base_wholesale_price, deposit_fee, current_stock, units_per_case, is_active)
       VALUES ('TEST_PRICE_CONSENT Product', $1, 'Beer', 'case', 700.00, 0, 100, 24, TRUE)
       RETURNING id`,
      [`PC-${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use('/api/v1/customers', customerRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (customerId) {
      await db.query(
        `DELETE FROM inventory_audit_logs
          WHERE related_order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [customerId]
      );
      await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
      await db.query('DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
      await db.query(
        `DELETE FROM activity_logs
          WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [customerId]
      );
      await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
      await db.query('DELETE FROM customer_product_prices WHERE customer_id = $1', [customerId]);
      await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
    }
    if (productId) {
      await db.query('DELETE FROM customer_product_prices WHERE product_id = $1', [productId]);
      await db.query('DELETE FROM products WHERE id = $1', [productId]);
    }
  });

  it('1. Saving an order with a hand-typed price writes no saved price (prompt declined)', async () => {
    assert.equal(await savedPriceCount(), 0, 'precondition: customer starts with no saved prices');

    const res = await api('/orders', {
      method: 'POST',
      body: {
        customer_id: customerId,
        order_type: 'delivery',
        items: [{
          product_id: productId,
          quantity: 2,
          unit_price: 600,          // hand-typed, below the 700 standard rate
          unit_deposit_fee: 0,
          units_per_case: 24,
          is_price_overridden: true,
        }],
      },
    });

    assert.equal(res.status, 201);
    // Declining the prompt is a no-op on the client, so "no row written by the POST"
    // is exactly what "answered No" looks like from the database's side.
    assert.equal(await savedPriceCount(), 0, 'order save must not persist a standing price');

    const list = await api(`/customers/${customerId}/prices?order_type=delivery`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.data, []);
  });

  it('2. The line still records that its price was overridden', async () => {
    const { rows } = await db.query(
      `SELECT oi.is_price_overridden, oi.unit_price
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.customer_id = $1`,
      [customerId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_price_overridden, true);
    assert.equal(Number(rows[0].unit_price), 600);
  });

  it('3. Answering Yes — POST /customers/:id/prices — writes exactly one saved price', async () => {
    const res = await api(`/customers/${customerId}/prices`, {
      method: 'POST',
      body: { product_id: productId, custom_unit_price: 600, order_type: 'delivery' },
    });

    assert.equal(res.status, 201);
    assert.equal(await savedPriceCount(), 1);

    const list = await api(`/customers/${customerId}/prices?order_type=delivery`);
    assert.equal(list.data.length, 1);
    assert.equal(Number(list.data[0].custom_unit_price), 600);
  });

  it('4. A second order at the same hand-typed price adds no further rows', async () => {
    const res = await api('/orders', {
      method: 'POST',
      body: {
        customer_id: customerId,
        order_type: 'delivery',
        items: [{
          product_id: productId,
          quantity: 1,
          unit_price: 600,
          unit_deposit_fee: 0,
          units_per_case: 24,
          is_price_overridden: true,
        }],
      },
    });

    assert.equal(res.status, 201);
    // customer_product_prices is append-only and read newest-first, so a duplicate row per
    // order would quietly pile up history nobody asked for.
    assert.equal(await savedPriceCount(), 1);
  });

  it('5. A draft with a hand-typed price writes no saved price either', async () => {
    const res = await api('/orders', {
      method: 'POST',
      body: {
        customer_id: customerId,
        order_type: 'pickup',
        status: 'draft',
        items: [{
          product_id: productId,
          quantity: 1,
          unit_price: 555,
          unit_deposit_fee: 0,
          units_per_case: 24,
          is_price_overridden: true,
        }],
      },
    });

    assert.equal(res.status, 201);
    const pickup = await api(`/customers/${customerId}/prices?order_type=pickup`);
    assert.deepEqual(pickup.data, [], 'a parked draft must not set a standing pickup rate');
  });
});
