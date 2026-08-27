const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const customerRoutes = require('../src/routes/customers');
const { errorHandler } = require('../src/middleware/errorHandler');

// ADR 0009 — customer_type is a descriptive tag; saved prices are the pricing source.
// 'unassigned' was collapsed into 'regular' by migration 034, so it is now an invalid type
// and a 'regular' customer holding saved prices is an ordinary, supported case.
describe('Customer Types & Custom Pricing (ADR 0009)', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let createdCustomerIds = [];
  let testProductId;

  before(async () => {
    // 1. Get or create admin user for auth
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-cust-types@leyblestore.com', 'dummyhash', 'Customer Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    testUserId = user.id;

    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    // 2. Create a test product for custom price tests
    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, sku, category, base_wholesale_price, current_stock, unit, units_per_case)
       VALUES ('TEST_CUST_PROD', 'TCP-01', 'Soft Drinks', 500.00, 100, 'case', 24)
       RETURNING id`
    );
    testProductId = product.id;

    // Express app setup
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/customers', customerRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1/customers`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (createdCustomerIds.length > 0) {
      await db.query(`DELETE FROM customer_product_prices WHERE customer_id = ANY($1::int[])`, [createdCustomerIds]);
      await db.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [createdCustomerIds]);
    }
    if (testProductId) {
      await db.query(`DELETE FROM customer_product_prices WHERE product_id = $1`, [testProductId]);
      await db.query(`DELETE FROM products WHERE id = $1`, [testProductId]);
    }
  });

  async function apiRequest(endpoint, { method = 'GET', body } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    };
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  it('1. Successfully creates a customer with customer_type="discounted"', async () => {
    const res = await apiRequest('', {
      method: 'POST',
      body: {
        name: 'TEST Discounted Suki Store',
        customer_type: 'discounted',
        phone: '09123456781',
        address: 'Barangay San Roque',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.customer_type, 'discounted');
    assert.equal(res.data.name, 'TEST Discounted Suki Store');
    createdCustomerIds.push(res.data.id);
  });

  it('2. Successfully creates a customer with customer_type="regular" (quick create default)', async () => {
    const res = await apiRequest('', {
      method: 'POST',
      body: {
        name: 'TEST Regular Walk-in Store',
        customer_type: 'regular',
        phone: '09123456782',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.customer_type, 'regular');
    assert.equal(res.data.name, 'TEST Regular Walk-in Store');
    createdCustomerIds.push(res.data.id);
  });

  it('3. Successfully creates a customer with customer_type="markup"', async () => {
    const res = await apiRequest('', {
      method: 'POST',
      body: {
        name: 'TEST Markup Customer Store',
        customer_type: 'markup',
        phone: '09123456783',
        address: 'Barangay Dela Paz',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.customer_type, 'markup');
    assert.equal(res.data.name, 'TEST Markup Customer Store');
    createdCustomerIds.push(res.data.id);
  });

  it('4. Rejects invalid customer_type via DB check constraint', async () => {
    const res = await apiRequest('', {
      method: 'POST',
      body: {
        name: 'TEST Invalid Customer',
        customer_type: 'vip_gold',
      },
    });

    assert.equal(res.status, 500); // DB constraint violation returns 500 through errorHandler
  });

  it('4b. Rejects the retired "unassigned" type (migration 034 collapsed it into regular)', async () => {
    const res = await apiRequest('', {
      method: 'POST',
      body: {
        name: 'TEST Retired Unassigned Customer',
        customer_type: 'unassigned',
      },
    });

    assert.equal(res.status, 500);
  });

  it('5. Supports custom pricing for "discounted" customers', async () => {
    const custId = createdCustomerIds[0]; // discounted customer

    // POST /customers/:id/prices
    const setRes = await apiRequest(`/${custId}/prices`, {
      method: 'POST',
      body: {
        product_id: testProductId,
        custom_unit_price: 475.00,
        order_type: 'delivery',
        notes: 'Suki discounted rate',
      },
    });
    assert.equal(setRes.status, 201);
    assert.equal(Number(setRes.data.custom_unit_price), 475.00);

    // GET /customers/:id/prices?order_type=delivery
    const getRes = await apiRequest(`/${custId}/prices?order_type=delivery`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.length, 1);
    assert.equal(Number(getRes.data[0].custom_unit_price), 475.00);
  });

  it('6. Supports custom pricing for "regular" customers (ADR 0009 — no type gate)', async () => {
    const custId = createdCustomerIds[1]; // regular customer

    const setRes = await apiRequest(`/${custId}/prices`, {
      method: 'POST',
      body: {
        product_id: testProductId,
        custom_unit_price: 480.00,
        order_type: 'pickup',
        notes: 'Introductory pickup rate',
      },
    });
    assert.equal(setRes.status, 201);
    assert.equal(Number(setRes.data.custom_unit_price), 480.00);

    const getRes = await apiRequest(`/${custId}/prices?order_type=pickup`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.length, 1);
    assert.equal(Number(getRes.data[0].custom_unit_price), 480.00);
  });

  it('7. Supports custom pricing for "markup" customers', async () => {
    const custId = createdCustomerIds[2]; // markup customer

    const setRes = await apiRequest(`/${custId}/prices`, {
      method: 'POST',
      body: {
        product_id: testProductId,
        custom_unit_price: 550.00,
        order_type: 'delivery',
        notes: 'Remote delivery surcharge rate',
      },
    });
    assert.equal(setRes.status, 201);
    assert.equal(Number(setRes.data.custom_unit_price), 550.00);

    const getRes = await apiRequest(`/${custId}/prices?order_type=delivery`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.length, 1);
    assert.equal(Number(getRes.data[0].custom_unit_price), 550.00);
  });

  it('8. Allows updating customer_type between all valid types including markup', async () => {
    const custId = createdCustomerIds[1]; // regular customer

    // Update to markup
    const patch0 = await apiRequest(`/${custId}`, {
      method: 'PATCH',
      body: { customer_type: 'markup' },
    });
    assert.equal(patch0.status, 200);
    assert.equal(patch0.data.customer_type, 'markup');

    // Update to discounted
    const patch1 = await apiRequest(`/${custId}`, {
      method: 'PATCH',
      body: { customer_type: 'discounted' },
    });
    assert.equal(patch1.status, 200);
    assert.equal(patch1.data.customer_type, 'discounted');

    // Update to wholesaler
    const patch2 = await apiRequest(`/${custId}`, {
      method: 'PATCH',
      body: { customer_type: 'wholesaler' },
    });
    assert.equal(patch2.status, 200);
    assert.equal(patch2.data.customer_type, 'wholesaler');

    // Update to regular
    const patch3 = await apiRequest(`/${custId}`, {
      method: 'PATCH',
      body: { customer_type: 'regular' },
    });
    assert.equal(patch3.status, 200);
    assert.equal(patch3.data.customer_type, 'regular');
  });
});
