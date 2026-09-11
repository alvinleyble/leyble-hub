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

// docs/product/proposals/persistent-delivery-fee.md decisions 2/3/14 — a plain,
// mutable, nullable, charge-only per-customer column. PATCH is the only writer
// (decision 9: configured on the customer edit form only).
describe('Persistent delivery fee — customers.delivery_fee (proposal decisions 2/3/14)', () => {
  let server;
  let baseUrl;
  let authToken;
  let customerId;

  before(async () => {
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-delfee-cust@leyblestore.com', 'dummyhash', 'Delivery Fee Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('TEST_DELFEE Customer', 'regular', '1 Delivery Fee Road', '09180000001')
       RETURNING id`
    );
    customerId = customer.id;

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
    if (server) await new Promise((resolve) => server.close(resolve));
    if (customerId) await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
  });

  async function apiRequest(endpoint, { method = 'GET', body } = {}) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  it('1. A new customer starts with delivery_fee = null (decision 3)', async () => {
    const res = await apiRequest(`/${customerId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.delivery_fee, null);
  });

  it('2. PATCH sets a standing delivery fee', async () => {
    const res = await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: 150 } });
    assert.equal(res.status, 200);
    assert.equal(Number(res.data.delivery_fee), 150);
  });

  it('3. PATCH accepts an explicit ₱0.00 fee (decision 4 — configured, not unset)', async () => {
    const res = await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: 0 } });
    assert.equal(res.status, 200);
    assert.equal(Number(res.data.delivery_fee), 0);
  });

  it('4. PATCH rejects a negative delivery fee (decision 14 — charge-only)', async () => {
    const res = await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: -10 } });
    assert.equal(res.status, 400);
    // The rejected write must not have landed.
    const after1 = await apiRequest(`/${customerId}`);
    assert.equal(Number(after1.data.delivery_fee), 0);
  });

  it('5. PATCH with delivery_fee: null waives it back to "not configured"', async () => {
    await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: 200 } });
    const res = await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: null } });
    assert.equal(res.status, 200);
    assert.equal(res.data.delivery_fee, null);
  });

  it('6. Omitting delivery_fee entirely leaves the stored value untouched', async () => {
    await apiRequest(`/${customerId}`, { method: 'PATCH', body: { delivery_fee: 75 } });
    const res = await apiRequest(`/${customerId}`, { method: 'PATCH', body: { notes: 'unrelated edit' } });
    assert.equal(res.status, 200);
    assert.equal(Number(res.data.delivery_fee), 75);
  });
});
