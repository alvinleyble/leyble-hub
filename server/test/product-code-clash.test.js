const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET ||= 'test-jwt-secret-key-32-chars-minimum!!';
const db = require('../src/db');
const products = require('../src/routes/products');
const { errorHandler } = require('../src/middleware/errorHandler');
let server, url, token;
before(async () => {
  const { rows: [user] } = await db.query(`INSERT INTO users (email, password_hash, full_name, role) VALUES ('sku-clash@test.local', 'x', 'SKU tester', 'admin') ON CONFLICT (email) DO UPDATE SET is_active = TRUE RETURNING *`);
  token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/products', products);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://localhost:${server.address().port}/products`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
async function create(payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
test('duplicate SKU returns the authoritative product while preserving 409 duplicate, including own retry', async () => {
  const sku = `clash-${Date.now()}`;
  const payload = { name: 'Original drink', sku, unit: 'case', base_wholesale_price: 200, current_stock: 12 };
  const accepted = await create(payload);
  assert.equal(accepted.status, 201);
  for (const body of [payload, { ...payload, name: 'Other drink', base_wholesale_price: 999, current_stock: 90 }]) {
    const duplicate = await create(body);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'duplicate');
    assert.deepEqual(duplicate.body.existing_product, accepted.body);
    assert.equal(typeof duplicate.body.error, 'string');
  }
  const distinct = await create({ ...payload, sku: sku.toUpperCase() });
  assert.equal(distinct.status, 201, 'case-distinct SKU follows the database uniqueness semantics, not name normalization');
  const { rows } = await db.query('SELECT current_stock FROM products WHERE sku = $1', [sku]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].current_stock), 12);
});
