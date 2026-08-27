const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const customerRoutes = require('../src/routes/customers');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('Customer Merge (Housekeeping)', () => {
  let server, base, token, userId;
  const createdCustomerIds = [];
  const createdOrderIds = [];
  const createdProductIds = [];

  const api = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

  const json = async (r) => ({
    status: r.status,
    body: r.status === 204 ? null : await r.json(),
  });

  before(async () => {
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      ({ rows: [user] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('merge-test@leyblestore.com', 'dummyhash', 'Merge Tester', 'admin')
         RETURNING id, email, full_name, role`
      ));
    }
    userId = user.id;
    token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/customers', customerRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}/api/v1/customers`;
  });

  after(async () => {
    if (server) {
      await new Promise((r) => server.close(r));
    }

    // Cleanup created orders and items
    if (createdOrderIds.length > 0) {
      await db.query(`DELETE FROM order_items WHERE order_id = ANY($1::int[])`, [createdOrderIds]);
      await db.query(`DELETE FROM order_personnel WHERE order_id = ANY($1::int[])`, [createdOrderIds]);
      await db.query(`DELETE FROM inventory_audit_logs WHERE related_order_id = ANY($1::int[])`, [createdOrderIds]);
      await db.query(`DELETE FROM activity_logs WHERE entity_id = ANY($1::int[]) AND entity_type = 'order'`, [createdOrderIds]);
      await db.query(`DELETE FROM orders WHERE id = ANY($1::int[])`, [createdOrderIds]);
    }

    // Cleanup custom prices, activity logs, and customers
    if (createdCustomerIds.length > 0) {
      await db.query(`DELETE FROM customer_product_prices WHERE customer_id = ANY($1::int[])`, [createdCustomerIds]);
      await db.query(`DELETE FROM activity_logs WHERE entity_id = ANY($1::int[]) AND entity_type = 'customer'`, [createdCustomerIds]);
      await db.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [createdCustomerIds]);
    }

    if (createdProductIds.length > 0) {
      await db.query(`DELETE FROM products WHERE id = ANY($1::int[])`, [createdProductIds]);
    }
  });

  const mkCustomer = async (name, type = 'regular') => {
    const { rows: [c] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ($1, $2, '123 Main St', '09123456789')
       RETURNING *`,
      [name, type]
    );
    createdCustomerIds.push(c.id);
    return c;
  };

  const mkProduct = async (name) => {
    const sku = `SKU_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const { rows: [p] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ($1, 'Beer', 'case', $2, 500, 0, 100, TRUE)
       RETURNING *`,
      [name, sku]
    );
    createdProductIds.push(p.id);
    return p;
  };

  const mkOrder = async (customerId, totalAmount = 1000) => {
    const { rows: [o] } = await db.query(
      `INSERT INTO orders (customer_id, order_type, status, total_amount)
       VALUES ($1, 'delivery', 'pending', $2)
       RETURNING *`,
      [customerId, totalAmount]
    );
    createdOrderIds.push(o.id);
    return o;
  };

  const mkCustomPrice = async (customerId, productId, price = 450) => {
    const { rows: [cp] } = await db.query(
      `INSERT INTO customer_product_prices (customer_id, product_id, custom_unit_price, set_by_user_id, order_type)
       VALUES ($1, $2, $3, $4, 'delivery')
       RETURNING *`,
      [customerId, productId, price, userId]
    );
    return cp;
  };

  it('rejects self-merge (same source and target ID)', async () => {
    const cust = await mkCustomer('Merge Self Test');
    const res = await api(`/${cust.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_customer_id: cust.id }),
    });
    const { status, body } = await json(res);
    assert.equal(status, 400);
    assert.match(body.error, /cannot be the same/i);
  });

  it('rejects non-existent source customer ID', async () => {
    const target = await mkCustomer('Merge Target Exists');
    const res = await api(`/999999/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_customer_id: target.id }),
    });
    const { status, body } = await json(res);
    assert.equal(status, 404);
    assert.match(body.error, /source customer not found/i);
  });

  it('rejects non-existent target customer ID', async () => {
    const source = await mkCustomer('Merge Source Exists');
    const res = await api(`/${source.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_customer_id: 999999 }),
    });
    const { status, body } = await json(res);
    assert.equal(status, 404);
    assert.match(body.error, /target customer not found/i);
  });

  it('rejects missing or invalid target_customer_id', async () => {
    const source = await mkCustomer('Merge Missing Target');
    const res = await api(`/${source.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const { status, body } = await json(res);
    assert.equal(status, 400);
    assert.match(body.error, /target_customer_id is required/i);
  });

  it('successfully merges source customer into target customer', async () => {
    const source = await mkCustomer('Source Customer Dup', 'wholesaler');
    const target = await mkCustomer('Target Customer Keep', 'wholesaler');
    const prod = await mkProduct('Merge Test Product');

    // Create 2 orders for source customer, 1 order for target customer
    const order1 = await mkOrder(source.id, 1500);
    const order2 = await mkOrder(source.id, 2500);
    const order3 = await mkOrder(target.id, 3000);

    // Create custom prices for both source and target
    await mkCustomPrice(source.id, prod.id, 420);
    await mkCustomPrice(target.id, prod.id, 450);

    // Perform merge
    const res = await api(`/${source.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_customer_id: target.id }),
    });
    const { status, body } = await json(res);

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.source_customer_id, source.id);
    assert.equal(body.target_customer_id, target.id);
    assert.equal(body.orders_transferred, 2);

    // 1. Check orders were transferred to target
    const { rows: sourceOrders } = await db.query(
      'SELECT id FROM orders WHERE customer_id = $1',
      [source.id]
    );
    assert.equal(sourceOrders.length, 0);

    const { rows: targetOrders } = await db.query(
      'SELECT id FROM orders WHERE customer_id = $1 ORDER BY id',
      [target.id]
    );
    assert.equal(targetOrders.length, 3);
    const targetOrderIds = targetOrders.map((o) => o.id);
    assert.ok(targetOrderIds.includes(order1.id));
    assert.ok(targetOrderIds.includes(order2.id));
    assert.ok(targetOrderIds.includes(order3.id));

    // 2. Check source custom prices were deleted, target custom price retained
    const { rows: sourcePrices } = await db.query(
      'SELECT * FROM customer_product_prices WHERE customer_id = $1',
      [source.id]
    );
    assert.equal(sourcePrices.length, 0);

    const { rows: targetPrices } = await db.query(
      'SELECT * FROM customer_product_prices WHERE customer_id = $1',
      [target.id]
    );
    assert.equal(targetPrices.length, 1);
    assert.equal(Number(targetPrices[0].custom_unit_price), 450);

    // 3. Check source customer is permanently deleted
    const { rows: [sourceRow] } = await db.query(
      'SELECT id FROM customers WHERE id = $1',
      [source.id]
    );
    assert.equal(sourceRow, undefined);

    // Target customer still exists
    const { rows: [targetRow] } = await db.query(
      'SELECT id FROM customers WHERE id = $1',
      [target.id]
    );
    assert.ok(targetRow);

    // 4. Check activity log was written for the target customer
    const { rows: [activityLog] } = await db.query(
      `SELECT * FROM activity_logs
       WHERE entity_type = 'customer' AND entity_id = $1 AND action = 'merge'
       ORDER BY id DESC LIMIT 1`,
      [target.id]
    );
    assert.ok(activityLog);
    assert.equal(activityLog.performed_by, userId);
    assert.ok(activityLog.summary.includes(`Merged customer '${source.name}' (#${source.id}) into '${target.name}' (#${target.id})`));
  });
});
