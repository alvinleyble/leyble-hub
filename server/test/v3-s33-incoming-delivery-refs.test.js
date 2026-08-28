// V3.0 Slice 3.3 — the server half of ADR 0015 §8: offline incoming-delivery logging.
//
// One thing here is load-bearing and nothing on the device can compensate for getting
// it wrong. A delivery logged on a blind tablet is queued, and a queued record can be
// SENT MORE THAN ONCE — a POST that commits and then loses its response on the way back
// is retried by the outbox. Without an identity of its own that retry becomes a second
// truckload of stock in the ledger, silently. This is ADR 0006's mechanism applied to
// its second table, so these tests mirror the receipt-number ones in
// v25-offline-foundations.test.js deliberately.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const incomingRoutes = require('../src/routes/incoming');
const { errorHandler } = require('../src/middleware/errorHandler');
const { RECEIPT_TABLES } = require('../src/lib/idempotency');
const { parseDeliveryRef, formatDeliveryRef } = require('../src/lib/receiptNumbers');

describe('V3.0 Slice 3.3 — device-issued delivery references (ADR 0015 §8)', () => {
  let server;
  let baseUrl;
  let authToken;
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

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('TEST_S33_PROD', 'Beer', 'case', $1, 100, 0, 100, TRUE) RETURNING id`,
      [`SKU_S33_${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/incoming', incomingRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.query('DELETE FROM inventory_audit_logs WHERE product_id = $1', [productId]);
    await db.query('DELETE FROM supplier_delivery_items WHERE product_id = $1', [productId]);
    if (deliveryIds.length) {
      await db.query('DELETE FROM supplier_deliveries WHERE id = ANY($1::int[])', [deliveryIds]);
    }
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

  // Each test picks its own station so a re-run against a reused database cannot
  // collide with a delivery an earlier run already stored.
  let stationSeed = Math.floor(Date.now() / 1000) % 90000;
  const nextStation = () => ++stationSeed;

  const body = (over = {}) => ({
    supplier_name: 'TEST_S33 San Miguel Brewery',
    received_at: '2026-08-29',
    items: [{ product_id: productId, quantity_received: 5 }],
    ...over,
  });

  const stockNow = async () => {
    const { rows: [p] } = await db.query('SELECT current_stock FROM products WHERE id = $1', [productId]);
    return Number(p.current_stock);
  };

  it('the shared idempotency mechanism now covers supplier_deliveries, not only orders', () => {
    assert.ok(RECEIPT_TABLES.has('orders'));
    assert.ok(RECEIPT_TABLES.has('supplier_deliveries'));
  });

  it('parses and formats <station>-DEL-<sequence>, and never confuses it with a receipt number', () => {
    assert.deepEqual(parseDeliveryRef('7-DEL-00042'), { station: 7, sequence: 42 });
    assert.equal(formatDeliveryRef(7, 42), '7-DEL-00042');
    assert.throws(() => parseDeliveryRef('7-00042'), /Malformed delivery_ref/);
  });

  it('stores the device-issued reference and returns it on the delivery', async () => {
    const ref = formatDeliveryRef(nextStation(), 1);
    const res = await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) });
    assert.equal(res.status, 201);
    const delivery = await res.json();
    deliveryIds.push(delivery.id);
    assert.equal(delivery.delivery_ref, ref);
  });

  it('a second arrival of the same reference is a SUCCESS and leaves exactly one row', async () => {
    const ref = formatDeliveryRef(nextStation(), 1);
    const first = await (await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) })).json();
    deliveryIds.push(first.id);

    const res = await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) });
    assert.equal(res.status, 200, 'a resend is answered, never refused — the device has to be able to clear its outbox');
    const second = await res.json();
    assert.equal(second.id, first.id);

    const { rows } = await db.query(
      'SELECT id FROM supplier_deliveries WHERE receipt_station = $1 AND receipt_sequence = $2',
      [parseDeliveryRef(ref).station, parseDeliveryRef(ref).sequence]
    );
    assert.equal(rows.length, 1);
  });

  it('a resend does not restock a second time', async () => {
    const ref = formatDeliveryRef(nextStation(), 1);
    const before = await stockNow();

    const first = await (await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) })).json();
    deliveryIds.push(first.id);
    assert.equal(await stockNow(), before + 5);

    await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) });
    assert.equal(await stockNow(), before + 5, 'the ledger must not gain a second truckload');
  });

  it('two overlapping drains of the same reference still leave one row', async () => {
    const ref = formatDeliveryRef(nextStation(), 1);
    const before = await stockNow();

    // Both look, neither finds, both insert: the partial unique index catches the
    // loser and the route answers it with the winner's row.
    const [a, b] = await Promise.all([
      call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) }),
      call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: ref })) }),
    ]);
    assert.ok(a.ok && b.ok);
    const [ja, jb] = [await a.json(), await b.json()];
    deliveryIds.push(ja.id, jb.id);
    assert.equal(ja.id, jb.id);
    assert.equal(await stockNow(), before + 5);
  });

  it('a malformed reference is refused rather than silently dropped', async () => {
    const res = await call('/incoming', { method: 'POST', body: JSON.stringify(body({ delivery_ref: 'not-a-ref' })) });
    assert.equal(res.status, 400);
  });

  it('a delivery sent with no reference behaves exactly as before', async () => {
    const res = await call('/incoming', { method: 'POST', body: JSON.stringify(body()) });
    assert.equal(res.status, 201);
    const delivery = await res.json();
    deliveryIds.push(delivery.id);
    assert.equal(delivery.delivery_ref, null);
    assert.equal(delivery.receipt_station, null);
  });
});
