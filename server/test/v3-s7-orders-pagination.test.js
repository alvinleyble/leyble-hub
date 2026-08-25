require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
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

describe('V3.0 Slice 7: Orders List Pagination & Date Boundary Fix', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let testCustomerId;
  let testProductId;
  const createdOrderIds = [];

  before(async () => {
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-pagination@leyblestore.com', 'dummyhash', 'Pagination Tester', 'admin')
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
       VALUES ('Test Customer S7 Pagination', 'regular', '789 S7 Street', '09123456780')
       RETURNING id`
    );
    testCustomerId = customer.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('Test S7 Product', 'Soft Drinks', 'case', $1, 200, 0, 100, TRUE)
       RETURNING id`,
      [`SKU_S7_${Date.now()}`]
    );
    testProductId = product.id;

    // Create 5 test orders with known timestamps
    const timestamps = [
      '2026-08-25T08:00:00.000Z',
      '2026-08-25T14:30:00.000Z',
      '2026-08-25T20:00:00.000Z',
      '2026-08-26T09:00:00.000Z',
      '2026-08-27T10:00:00.000Z',
    ];

    for (let i = 0; i < timestamps.length; i++) {
      const { rows: [ord] } = await db.query(
        `INSERT INTO orders (customer_id, status, order_type, total_amount, created_at, updated_at)
         VALUES ($1, 'pending', 'delivery', $2, $3, $3)
         RETURNING id`,
        [testCustomerId, (i + 1) * 100, timestamps[i]]
      );
      createdOrderIds.push(ord.id);

      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, is_price_overridden, units_per_case, bottles_returned)
         VALUES ($1, $2, 1, $3, 0, false, 1, 0)`,
        [ord.id, testProductId, (i + 1) * 100]
      );
    }

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
    if (createdOrderIds.length > 0) {
      await db.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [createdOrderIds]);
      await db.query('DELETE FROM order_personnel WHERE order_id = ANY($1::int[])', [createdOrderIds]);
      await db.query('DELETE FROM orders WHERE id = ANY($1::int[])', [createdOrderIds]);
    }
    if (testCustomerId) {
      await db.query('DELETE FROM customers WHERE id = $1', [testCustomerId]);
    }
    if (testProductId) {
      await db.query('DELETE FROM products WHERE id = $1', [testProductId]);
    }
  });

  async function apiGet(path) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Active-Profile': 'admin',
      },
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  it('1. Legacy unpaginated request returns raw array of orders', async () => {
    const { status, body } = await apiGet(`?customer_id=${testCustomerId}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'Legacy response should be an array');
    assert.equal(body.length, 5, 'Should return all 5 orders');
    assert.equal(body[0].total_count, undefined, 'total_count should not leak to response rows');
  });

  it('2. Paginated request returns { orders, pagination } envelope', async () => {
    const { status, body } = await apiGet(`?customer_id=${testCustomerId}&page=1&limit=2`);
    assert.equal(status, 200);
    assert.ok(!Array.isArray(body), 'Paginated response should be an envelope object');
    assert.ok(Array.isArray(body.orders), 'orders should be an array');
    assert.equal(body.orders.length, 2, 'Should return limit=2 items');
    assert.deepEqual(body.pagination, {
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it('3. Page 2 returns next set of orders with offset applied', async () => {
    const page1Res = await apiGet(`?customer_id=${testCustomerId}&page=1&limit=2`);
    const page2Res = await apiGet(`?customer_id=${testCustomerId}&page=2&limit=2`);

    assert.equal(page2Res.status, 200);
    assert.equal(page2Res.body.orders.length, 2);
    assert.deepEqual(page2Res.body.pagination, {
      page: 2,
      limit: 2,
      total: 5,
      totalPages: 3,
    });

    const page1Ids = page1Res.body.orders.map((o) => o.id);
    const page2Ids = page2Res.body.orders.map((o) => o.id);
    assert.equal(page1Ids.some((id) => page2Ids.includes(id)), false, 'Page 1 and Page 2 IDs should not overlap');
  });

  it('4. Parameter clamping: page <= 0 becomes 1, limit > 200 clamped to 200', async () => {
    const resNegativePage = await apiGet(`?customer_id=${testCustomerId}&page=-5&limit=2`);
    assert.equal(resNegativePage.body.pagination.page, 1, 'Negative page should clamp to 1');

    const resLargeLimit = await apiGet(`?customer_id=${testCustomerId}&page=1&limit=500`);
    assert.equal(resLargeLimit.body.pagination.limit, 200, 'Limit > 200 should clamp to 200');

    const resZeroLimit = await apiGet(`?customer_id=${testCustomerId}&page=1&limit=0`);
    assert.equal(resZeroLimit.body.pagination.limit, 50, 'Limit 0 should fallback to 50');
  });

  it('5. Date boundary fix: to_date as YYYY-MM-DD is end-of-day inclusive', async () => {
    // 2026-08-25 has 3 orders: 08:00, 14:30, 20:00
    const { status, body } = await apiGet(`?customer_id=${testCustomerId}&from_date=2026-08-25&to_date=2026-08-25&page=1&limit=50`);
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 3, 'Should include all 3 orders placed on 2026-08-25');
    assert.equal(body.orders.length, 3);
  });

  it('6. Date boundary fix: to_date as ISO timestamp preserves exact comparison', async () => {
    // Exact comparison with timestamp 2026-08-25T14:00:00.000Z should only include the 08:00 order (not 14:30 or 20:00)
    const { status, body } = await apiGet(`?customer_id=${testCustomerId}&from_date=2026-08-25&to_date=2026-08-25T14:00:00.000Z&page=1&limit=50`);
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 1, 'Should only include the order before 14:00');
  });
});
