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

describe('ADR 0019 order revision compare-and-swap', () => {
  let server;
  let baseUrl;
  let token;
  let userId;
  let customerId;
  let productId;
  const runKey = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  before(async () => {
    const { rows: [user] } = await db.query("SELECT id, email, full_name, role FROM users WHERE email = 'alvin@leyblestore.com'");
    userId = user.id;
    token = jwt.sign({ id: user.id, email: user.email, role: user.role, full_name: user.full_name }, process.env.JWT_SECRET);
    ({ rows: [{ id: customerId }] } = await db.query(
      "INSERT INTO customers (name, customer_type) VALUES ($1, 'regular') RETURNING id",
      [`TEST_ADR19 Customer ${runKey}`]
    ));
    ({ rows: [{ id: productId }] } = await db.query(
      "INSERT INTO products (name, sku, unit, base_wholesale_price, current_stock) VALUES ($1, $2, 'cs', 100, 100) RETURNING id",
      [`TEST_ADR19 Product ${runKey}`, `ADR19-${runKey}`]
    ));

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
    // The audit tables are append-only even in tests. This suite always runs against
    // the documented throwaway database, so its uniquely named fixture is left there.
  });

  async function createOrder(status = 'pending') {
    const { rows: [order] } = await db.query(
      `INSERT INTO orders (customer_id, status, order_type, total_amount, created_by)
       VALUES ($1, $2, 'delivery', 200, $3) RETURNING *`,
      [customerId, status, userId]
    );
    await db.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
       VALUES ($1, $2, 2, 100)`,
      [order.id, productId]
    );
    return order;
  }

  async function call(id, suffix, { method = 'POST', body } = {}) {
    const response = await fetch(`${baseUrl}/${id}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }

  it('rejects a stale cancel atomically and returns the current order without restoring stock', async () => {
    const order = await createOrder();
    const beforeStock = Number((await db.query('SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0].current_stock);

    const dispatch = await call(order.id, '/status', {
      body: { status: 'in_transit', expected_status: 'pending', revision: order.revision },
    });
    assert.equal(dispatch.status, 200);
    assert.ok(BigInt(dispatch.body.revision) > BigInt(order.revision));

    const stale = await call(order.id, '/status', {
      body: { status: 'cancelled', expected_status: 'pending', revision: order.revision },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_write');
    assert.equal(stale.body.order.status, 'in_transit');
    assert.equal(stale.body.current_revision, dispatch.body.revision);

    const afterStock = Number((await db.query('SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0].current_stock);
    assert.equal(afterStock, beforeStock - 2, 'the stale cancel must not restore dispatched stock');
  });

  it('allows exactly one of two simultaneous edits formed from the same revision', async () => {
    const order = await createOrder();
    const edit = (notes) => call(order.id, '', {
      method: 'PATCH', body: { notes, revision: order.revision },
    });
    const results = await Promise.all([edit('Device A'), edit('Device B')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200).body;
    const loser = results.find((r) => r.status === 409).body;
    assert.equal(loser.code, 'stale_write');
    assert.equal(loser.order.notes, winner.notes);
    const stored = (await db.query('SELECT notes, revision FROM orders WHERE id = $1', [order.id])).rows[0];
    assert.equal(stored.notes, winner.notes);
    assert.equal(stored.revision, winner.revision);
  });

  it('guards adjustments, bumps items-only edits, and keeps old APK requests compatible', async () => {
    const order = await createOrder();
    const adjustment = await call(order.id, '/adjustment', {
      method: 'PATCH', body: { adjustment: -25, adjustment_reason: 'Agreed', revision: order.revision },
    });
    assert.equal(adjustment.status, 200);

    const staleAdjustment = await call(order.id, '/adjustment', {
      method: 'PATCH', body: { adjustment: -50, adjustment_reason: 'Old screen', revision: order.revision },
    });
    assert.equal(staleAdjustment.status, 409);
    assert.equal(Number(staleAdjustment.body.order.adjustment), -25);

    const itemsEdit = await call(order.id, '', {
      method: 'PATCH',
      body: {
        revision: adjustment.body.revision,
        items: [{ product_id: productId, quantity: 3, unit_price: 100 }],
      },
    });
    assert.equal(itemsEdit.status, 200);
    assert.ok(BigInt(itemsEdit.body.revision) > BigInt(adjustment.body.revision));

    const legacy = await createOrder();
    const legacyResult = await call(legacy.id, '/status', { body: { status: 'cancelled' } });
    assert.equal(legacyResult.status, 200, 'revision remains optional for mixed-fleet rollout');
  });

  it('leaves additive receipt-print recording unguarded', async () => {
    const order = await createOrder();
    const printed = await call(order.id, '/receipt-printed', { body: { phase: 'pending' } });
    assert.equal(printed.status, 200);
    assert.ok(printed.body.pending_receipt_printed_at);
  });
});
