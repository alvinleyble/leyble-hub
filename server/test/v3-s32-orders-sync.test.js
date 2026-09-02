// V3.0 Slice 3.2 — the server half of full offline sync.
//
// GET /orders/sync is what a tablet mirrors history through, so three things carry the
// whole design and nothing downstream can compensate for getting them wrong:
//   * snapshots are COMPLETE (line items + personnel) — a summary row is exactly what
//     used to crash the offline order detail page (ADR 0015 §4)
//   * keyset pagination on (updated_at, id) walks BOTH ways: backwards to backfill a
//     brand-new tablet resumably, forwards to hand an already-set-up one only what
//     changed — including orders created on other tablets
//   * the delta filters on the reference endpoints (`updated_since`) are additive: an
//     unchanged request must behave exactly as it always has
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
const productRoutes = require('../src/routes/products');
const customerRoutes = require('../src/routes/customers');
const personnelRoutes = require('../src/routes/personnel');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('V3.0 Slice 3.2: GET /orders/sync and the reference-data deltas', () => {
  let server;
  let baseUrl;
  let authToken;
  let customerId;
  let productId;
  let personnelId;
  const orderIds = [];

  const tag = `S32_${Date.now()}`;

  before(async () => {
    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE profile_key = 'admin' LIMIT 1`
    );
    authToken = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, full_name: admin.full_name },
      process.env.JWT_SECRET
    );

    ({ rows: [{ id: customerId }] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ($1, 'regular', '12 Sumulong Hwy', '09170000000') RETURNING id`,
      [`TEST_${tag}_CUSTOMER`]
    ));
    ({ rows: [{ id: productId }] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, units_per_case, is_active)
       VALUES ($1, 'Beer', 'case', $2, 100, 0, 500, 24, TRUE) RETURNING id`,
      [`TEST_${tag}_PROD`, `SKU_${tag}`]
    ));
    ({ rows: [{ id: personnelId }] } = await db.query(
      `INSERT INTO personnel (full_name, phone) VALUES ($1, '09170000001') RETURNING id`,
      [`TEST_${tag}_DRIVER`]
    ));

    // Four orders with known, distinct updated_at values so keyset paging is
    // deterministic rather than dependent on how fast the inserts ran.
    for (let i = 1; i <= 4; i++) {
      const at = `2026-08-${String(20 + i)}T02:00:00Z`;
      const { rows: [order] } = await db.query(
        `INSERT INTO orders (customer_id, total_amount, order_type, status, created_at, updated_at)
         VALUES ($1, 0, 'delivery', 'pending', $2, $2) RETURNING id`,
        [customerId, at]
      );
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, units_per_case)
         VALUES ($1, $2, 2, 100, 0, 24)`,
        [order.id, productId]
      );
      await db.query(
        `INSERT INTO order_personnel (order_id, personnel_id, role) VALUES ($1, $2, 'Driver')`,
        [order.id, personnelId]
      );
      orderIds.push(order.id);
    }

    // A draft, which history now includes (2026-09-02: a historical draft must be as
    // offline-readable as any other synced order, not gated on a per-view fetch).
    const { rows: [draft] } = await db.query(
      `INSERT INTO orders (customer_id, total_amount, order_type, status, created_at, updated_at)
       VALUES ($1, 0, 'delivery', 'draft', '2026-08-26T02:00:00Z', '2026-08-26T02:00:00Z') RETURNING id`,
      [customerId]
    );
    await db.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, units_per_case)
       VALUES ($1, $2, 1, 100, 0, 24)`,
      [draft.id, productId]
    );
    await db.query(
      `INSERT INTO order_personnel (order_id, personnel_id, role) VALUES ($1, $2, 'Driver')`,
      [draft.id, personnelId]
    );
    orderIds.push(draft.id);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use('/api/v1/products', productRoutes);
    app.use('/api/v1/customers', customerRoutes);
    app.use('/api/v1/personnel', personnelRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (orderIds.length) {
      await db.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
      await db.query('DELETE FROM order_personnel WHERE order_id = ANY($1::int[])', [orderIds]);
      await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id = ANY($1::int[])`, [orderIds]);
      await db.query('DELETE FROM orders WHERE id = ANY($1::int[])', [orderIds]);
    }
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await db.query('DELETE FROM products WHERE id = $1', [productId]);
    await db.query('DELETE FROM personnel WHERE id = $1', [personnelId]);
  });

  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${authToken}`, 'X-Active-Profile': 'admin' },
    });
    return { status: res.status, body: await res.json() };
  }

  const ours = (orders) => orders.filter((o) => o.customer_id === customerId);

  it('hands back COMPLETE snapshots — line items and personnel, not summary rows — and includes drafts', async () => {
    const { status, body } = await get('/orders/sync?direction=back&limit=200');
    assert.equal(status, 200);

    const mine = ours(body.orders);
    assert.equal(mine.length, 5, 'four orders plus the draft — a draft is history too, 2026-09-02');
    for (const order of mine) {
      assert.ok(Array.isArray(order.items) && order.items.length === 1,
        'a snapshot without its items is what crashed OrderDetailPage offline');
      assert.equal(Number(order.items[0].product_id), productId);
      assert.ok(order.items[0].sku, 'items carry the product fields the receipt prints');
      assert.equal(order.items[0].unit_deposit_fee !== undefined, true);
      assert.ok(Array.isArray(order.personnel) && order.personnel.length === 1);
      assert.equal(order.personnel[0].role, 'Driver');
      assert.ok(order.customer_name, 'and the customer the order belongs to');
    }
    assert.ok(mine.some((o) => o.status === 'draft'),
      'a historical draft must ride the bulk sync, not only the per-view fallback');
  });

  it('walks backwards newest-first and resumes from a cursor rather than restarting', async () => {
    const first = await get('/orders/sync?direction=back&limit=2');
    assert.equal(first.body.has_more, true);
    const page1 = first.body.orders;
    assert.equal(page1.length, 2);
    assert.ok(String(page1[0].updated_at) >= String(page1[1].updated_at), 'newest first');

    assert.ok(first.body.next_cursor, 'the SERVER mints the cursor, at microsecond precision');
    assert.ok(first.body.first_cursor);
    const last = page1[page1.length - 1];
    const second = await get(`/orders/sync?direction=back&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);

    const seen = new Set(page1.map((o) => o.id));
    assert.ok(second.body.orders.every((o) => !seen.has(o.id)), 'a cursor never re-serves a page');
    assert.ok(second.body.orders.every((o) => String(o.updated_at) <= String(last.updated_at)));
  });

  it('walks forwards from a cursor and returns only what changed since', async () => {
    // Pretend the tablet last synced through the second-oldest of our four orders.
    const all = ours((await get('/orders/sync?direction=back&limit=200')).body.orders);
    const ascending = [...all].sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    const watermark = ascending[1];
    // Ask the SERVER for that row's own cursor rather than composing one from the JSON
    // timestamp — see the precision note on the route. Walking back one page at a time
    // until the watermark is the last row of the page hands us exactly that cursor.
    let cursor = null;
    for (let limit = 1; limit <= 200; limit++) {
      const page = await get(`/orders/sync?direction=back&limit=${limit}`);
      const rows = page.body.orders;
      if (rows[rows.length - 1].id === watermark.id) { cursor = page.body.next_cursor; break; }
      if (!page.body.has_more) break;
    }
    assert.ok(cursor, 'the watermark row must be reachable by walking back');

    const { body } = await get(`/orders/sync?direction=forward&limit=200&cursor=${encodeURIComponent(cursor)}`);
    const mine = ours(body.orders);

    assert.deepEqual(
      mine.map((o) => o.id),
      ascending.slice(2).map((o) => o.id),
      'exactly the orders newer than the watermark, oldest first',
    );
  });

  it('a touched order reappears in the forward delta — which is how another tablet\'s work arrives', async () => {
    const newestPage = await get('/orders/sync?direction=back&limit=200');
    const all = ours(newestPage.body.orders);
    const cursor = encodeURIComponent(newestPage.body.first_cursor);

    const before = await get(`/orders/sync?direction=forward&limit=200&cursor=${cursor}`);
    assert.equal(before.body.orders.length, 0,
      'nothing is newer than the newest row — a cursor rebuilt from a millisecond timestamp would wrongly re-serve it');

    const target = all[all.length - 1];
    await db.query(`UPDATE orders SET notes = 'touched', updated_at = NOW() WHERE id = $1`, [target.id]);

    const after = await get(`/orders/sync?direction=forward&limit=200&cursor=${cursor}`);
    const mine = ours(after.body.orders);
    assert.deepEqual(mine.map((o) => o.id), [target.id]);
    assert.equal(mine[0].notes, 'touched');
    assert.equal(mine[0].items.length, 1, 'and it still arrives complete');
  });

  it('refuses a malformed cursor rather than silently serving page one again', async () => {
    const { status } = await get('/orders/sync?direction=back&cursor=garbage');
    assert.equal(status, 400);
  });

  it('updated_since narrows the reference endpoints, and omitting it changes nothing', async () => {
    const full = await get('/products?include_inactive=true');
    assert.equal(full.status, 200);
    assert.ok(full.body.some((p) => p.id === productId), 'the unfiltered list is unchanged');

    const future = await get('/products?include_inactive=true&updated_since=2099-01-01T00:00:00Z');
    assert.deepEqual(future.body, [], 'nothing has changed since the far future');

    await db.query(`UPDATE products SET base_wholesale_price = 111, updated_at = NOW() WHERE id = $1`, [productId]);
    const since = new Date(Date.now() - 5000).toISOString();
    const delta = await get(`/products?include_inactive=true&updated_since=${encodeURIComponent(since)}`);
    assert.ok(delta.body.some((p) => p.id === productId), 'the touched product is in the delta');

    for (const path of ['/customers', '/personnel']) {
      const res = await get(`${path}?include_inactive=true&updated_since=2099-01-01T00:00:00Z`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, [], `${path} honours updated_since too`);
    }
  });

  it('a soft-deleted row still reaches the delta, so a tablet can learn it was deactivated', async () => {
    await db.query('UPDATE customers SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [customerId]);
    const since = new Date(Date.now() - 5000).toISOString();

    const withInactive = await get(`/customers?include_inactive=true&updated_since=${encodeURIComponent(since)}`);
    assert.ok(withInactive.body.some((c) => c.id === customerId && c.is_active === false),
      'the deactivation is a change like any other — a cache that never hears about it keeps selling to her');

    const activeOnly = await get(`/customers?updated_since=${encodeURIComponent(since)}`);
    assert.ok(!activeOnly.body.some((c) => c.id === customerId),
      'and the default, active-only shape is untouched');

    await db.query('UPDATE customers SET is_active = TRUE WHERE id = $1', [customerId]);
  });
});
