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
async function send(method, path, payload) {
  const res = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
const create = (payload) => send('POST', '', payload);
test('duplicate SKU returns the authoritative product while preserving 409 duplicate, including a keyless resend', async () => {
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

test('a resent create carrying its own request key is answered with the product it made, even after another device changed it', async () => {
  const sku = `own-${Date.now()}`;
  const payload = { name: 'Own drink', sku, unit: 'case', base_wholesale_price: 200, current_stock: 12, request_key: `own-key-${Date.now()}` };
  const accepted = await create(payload);
  assert.equal(accepted.status, 201);
  const edited = await send('PATCH', `/${accepted.body.id}`, { base_wholesale_price: 210, current_stock: 8 });
  assert.equal(edited.status, 200);

  const resent = await create(payload);
  assert.equal(resent.status, 200, 'its own earlier attempt, not a clash');
  assert.equal(resent.body.id, accepted.body.id);
  assert.equal(Number(resent.body.base_wholesale_price), 210, 'the product as it stands now');
  assert.equal(Number(resent.body.current_stock), 8, 'initial stock is never applied twice');

  const otherDevice = await create({ ...payload, request_key: `other-key-${Date.now()}` });
  assert.equal(otherDevice.status, 409, 'a different device with the same code is still a clash');
  assert.equal(otherDevice.body.code, 'duplicate');
  const { rows } = await db.query('SELECT id FROM products WHERE sku = $1', [sku]);
  assert.equal(rows.length, 1);
});

test('a resent create with no product code and its own request key does not make a second product', async () => {
  const name = `No-code drink ${Date.now()}`;
  const payload = { name, unit: 'case', base_wholesale_price: 50, current_stock: 3, request_key: `nocode-key-${Date.now()}` };
  const accepted = await create(payload);
  assert.equal(accepted.status, 201);
  const resent = await create(payload);
  assert.equal(resent.status, 200);
  assert.equal(resent.body.id, accepted.body.id);
  const { rows } = await db.query('SELECT current_stock FROM products WHERE name = $1', [name]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].current_stock), 3);
});

test('a malformed request key on a product create is refused, never ignored', async () => {
  const result = await create({ name: 'Bad key drink', unit: 'case', request_key: 'not a key!' });
  assert.equal(result.status, 400);
});
