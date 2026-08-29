// V2.5 Release 1, piece 1 — the server half of the offline foundations.
//
// Three things are load-bearing here and nothing else in the release can compensate
// for getting them wrong: station numbers never repeat (D1), a resent receipt number
// never becomes a second order (D13), and a drained record is attributed to the profile
// that made it rather than the one draining it (D14). Plus the device's sale time (D5).
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
const stationRoutes = require('../src/routes/stations');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('V2.5 offline foundations — stations, receipt numbers, resend, attribution', () => {
  let server;
  let baseUrl;
  let authToken;
  let adminUserId;
  let customerId;
  let productId;
  const deviceKeys = [];

  before(async () => {
    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE profile_key = 'admin' LIMIT 1`
    );
    adminUserId = admin.id;
    authToken = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, full_name: admin.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_V25_CUSTOMER', 'regular') RETURNING id`
    );
    customerId = customer.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('TEST_V25_PROD', 'Beer', 'case', $1, 100, 0, 500, TRUE) RETURNING id`,
      [`SKU_V25_${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use('/api/v1/stations', stationRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.query(
      `DELETE FROM inventory_audit_logs
        WHERE product_id = $1
           OR related_order_id IN (SELECT id FROM orders WHERE customer_id = $2)`,
      [productId, customerId]
    );
    await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
    await db.query('DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [customerId]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    await db.query('DELETE FROM customer_product_prices WHERE customer_id = $1', [customerId]);
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await db.query('DELETE FROM products WHERE id = $1', [productId]);
    if (deviceKeys.length) {
      await db.query('DELETE FROM stations WHERE device_key = ANY($1::text[])', [deviceKeys]);
    }
  });

  function call(path, { profile, ...options } = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(profile ? { 'X-Active-Profile': profile } : {}),
        ...(options.headers || {}),
      },
    });
  }

  function newDeviceKey(tag) {
    const key = `TEST_V25_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    deviceKeys.push(key);
    return key;
  }

  // ADR 0016 caps the station component at this store's three slots, so tests vary
  // their SEQUENCE rather than their station to stay unique across re-runs against a
  // reused database. Everything below stays inside 1, 2, 3.
  let sequenceSeed = Date.now() % 80000;
  const testReceipt = (slot = 1) => `${slot}-${String(++sequenceSeed).padStart(5, '0')}`;

  const orderBody = (over = {}) => ({
    customer_id: customerId,
    items: [{ product_id: productId, quantity: 1, unit_price: 100 }],
    ...over,
  });

  // ── D1 / ADR 0016: station slots ──────────────────────────────────────────
  //
  // ADR 0016 replaced ADR 0003's "the next value of a sequence, forever" with three
  // fixed slots. Everything else about a station number is untouched — it is still
  // stored on the device, still used with no round trip, still the anti-duplicate key
  // — so what has to hold here is: a slot is only ever held by one device, a fourth
  // device gets nothing rather than a number 4, and reassigning a slot continues its
  // numbering rather than restarting it.

  describe('ADR 0016 — three fixed station slots', () => {
    // The suite shares a database with whatever else has registered against it, so
    // each case parks the slots in a known state first rather than assuming they are free.
    async function clearSlots() {
      await db.query('UPDATE stations SET slot_number = NULL, slot_assigned_at = NULL, slot_assigned_by = NULL');
    }

    const register = (key) => call('/stations/register', {
      method: 'POST', body: JSON.stringify({ device_key: key }),
    }).then((r) => r.json());

    it('gives the first three devices slots 1, 2 and 3 — and the fourth nothing at all', async () => {
      await clearSlots();
      const a = await register(newDeviceKey('SLOT_A'));
      const b = await register(newDeviceKey('SLOT_B'));
      const c = await register(newDeviceKey('SLOT_C'));
      const d = await register(newDeviceKey('SLOT_D'));

      assert.deepEqual([a.slot_number, b.slot_number, c.slot_number], [1, 2, 3]);
      assert.deepEqual([a.station_number, b.station_number, c.station_number], [1, 2, 3]);
      assert.deepEqual([a.owner_name, b.owner_name, c.owner_name], ['Alvin', 'Josie', 'Luis']);

      // The whole point of ADR 0016: no number 4 exists to hand out.
      assert.equal(d.slot_number, null);
      assert.equal(d.station_number, null);
      assert.equal(d.unassigned, true);
    });

    it('is idempotent on device_key — a retried registration keeps the same slot', async () => {
      await clearSlots();
      const key = newDeviceKey('SLOT_RETRY');
      const first = await register(key);
      const second = await register(key);
      assert.equal(second.slot_number, first.slot_number);
      assert.equal(second.created, false);
    });

    it('moves a slot to a replacement device, and continues its numbering past what was issued', async () => {
      await clearSlots();
      const oldTablet = newDeviceKey('SLOT_OLD');
      const newTablet = newDeviceKey('SLOT_NEW');
      const claimed = await register(oldTablet);
      await register(newDeviceKey('SLOT_FILLER_B'));
      await register(newDeviceKey('SLOT_FILLER_C'));
      // The replacement arrives with all three slots taken and gets none.
      assert.equal((await register(newTablet)).slot_number, null);

      const slot = claimed.slot_number;
      const printed = 40;
      await call('/orders', {
        method: 'POST',
        body: JSON.stringify(orderBody({ receipt_number: `${slot}-${String(printed).padStart(5, '0')}` })),
      });

      const moved = await (await call(`/stations/slots/${slot}/assign`, {
        method: 'POST', body: JSON.stringify({ device_key: newTablet }),
      })).json();

      assert.equal(moved.slot_number, slot);
      assert.equal(moved.replaced_previous, true);
      assert.ok(
        moved.next_sequence > printed,
        'the replacement continues past what the old tablet printed, never back at 1'
      );

      // Exactly one device holds the slot: the old tablet is released in the same act.
      const { rows } = await db.query('SELECT device_key FROM stations WHERE slot_number = $1', [slot]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].device_key, newTablet);

      // And the released tablet is told so the next time it asks.
      const released = await register(oldTablet);
      assert.equal(released.slot_number, null);
      assert.equal(released.unassigned, true);
    });

    it('lists the three slots and every device left without one', async () => {
      await clearSlots();
      const held = newDeviceKey('SLOT_LIST_HELD');
      await register(held);
      const spare = newDeviceKey('SLOT_LIST_SPARE');
      await register(newDeviceKey('SLOT_LIST_B'));
      await register(newDeviceKey('SLOT_LIST_C'));
      await register(spare);

      const roster = await (await call('/stations')).json();
      assert.deepEqual(roster.slots.map((s) => s.slot_number), [1, 2, 3]);
      assert.deepEqual(roster.slots.map((s) => s.owner_name), ['Alvin', 'Josie', 'Luis']);
      assert.equal(roster.slots.find((s) => s.slot_number === 1).device.device_key, held);
      assert.ok(roster.unassigned.some((d) => d.device_key === spare));
    });

    it('refuses a slot outside 1-3, and an assignment to a device it has never seen', async () => {
      const bad = await call('/stations/slots/4/assign', {
        method: 'POST', body: JSON.stringify({ device_key: 'anything' }),
      });
      assert.equal(bad.status, 400);

      const stranger = await call('/stations/slots/1/assign', {
        method: 'POST', body: JSON.stringify({ device_key: 'TEST_V25_NEVER_REGISTERED' }),
      });
      assert.equal(stranger.status, 404);
    });

    it('refuses a registration with no device_key', async () => {
      const res = await call('/stations/register', { method: 'POST', body: JSON.stringify({}) });
      assert.equal(res.status, 400);
    });

    it('refuses an order whose receipt number comes from a station above 3', async () => {
      const res = await call('/orders', {
        method: 'POST',
        body: JSON.stringify(orderBody({ receipt_number: `8-${String(++sequenceSeed).padStart(5, '0')}` })),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /1, 2 or 3/);
    });
  });

  // ── D13: the receipt number is the anti-duplicate key ─────────────────────

  describe('D13 — resending a receipt number', () => {
    it('stores the device-issued number and returns it on the order', async () => {
      const receipt = testReceipt(3);
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, receipt);
      assert.equal(order.receipt_station, 3);
    });

    it('a second arrival of the same number is a SUCCESS and leaves exactly one row', async () => {
      const receipt = testReceipt(2);

      const first = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(first.status, 201);
      const created = await first.json();

      // The outbox retries because the first response never made it back.
      const second = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(second.ok, true, 'a resend must succeed so the device stops retrying');
      assert.equal(second.status, 200, 'and be distinguishable from a fresh create');
      const replayed = await second.json();
      assert.equal(replayed.id, created.id);

      const { rows } = await db.query(
        'SELECT id FROM orders WHERE receipt_station = $1 AND receipt_sequence = $2',
        [Number(receipt.split('-')[0]), Number(receipt.split('-')[1])]
      );
      assert.equal(rows.length, 1, 'exactly one order row');
    });

    it('a resend does not deduct stock a second time', async () => {
      const receipt = testReceipt(1);
      const stock = async () =>
        Number((await db.query('SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0].current_stock);
      const before = await stock();

      const first = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt, items: [{ product_id: productId, quantity: 3, unit_price: 100 }] })) });
      const order = await first.json();
      // ADR 0012 — a drained order is created, not dispatched; the stock moves later.
      assert.equal(await stock(), before);

      await call(`/orders/${receipt}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) });
      const afterDispatch = await stock();
      assert.equal(afterDispatch, before - 3);

      const replay = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt, items: [{ product_id: productId, quantity: 3, unit_price: 100 }] })) });
      assert.equal((await replay.json()).id, order.id);
      assert.equal(await stock(), afterDispatch, 'the replay is a read, not a second sale');
    });

    it('two overlapping drains of the same number still leave one row', async () => {
      const receipt = testReceipt(2);
      const [a, b] = await Promise.all([
        call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) }),
        call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) }),
      ]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      const [ja, jb] = [await a.json(), await b.json()];
      assert.equal(ja.id, jb.id);

      const { rows } = await db.query(
        'SELECT id FROM orders WHERE receipt_station = $1 AND receipt_sequence = $2',
        [Number(receipt.split('-')[0]), Number(receipt.split('-')[1])]
      );
      assert.equal(rows.length, 1);
    });

    it('a parked order carries the same protection — it is an orders row too', async () => {
      const receipt = testReceipt(3);
      const body = orderBody({ receipt_number: receipt, status: 'draft' });
      const first = await call('/orders', { method: 'POST', body: JSON.stringify(body) });
      const second = await call('/orders', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal((await first.json()).id, (await second.json()).id);
    });

    it('a malformed receipt number is refused rather than silently dropped', async () => {
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: 'abc' })) });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /receipt_number/);
    });

    it('an order sent with no receipt number behaves exactly as before', async () => {
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody()) });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, null);
      assert.equal(order.receipt_station, null);
    });
  });

  // ── D5: the sale time comes from the device ───────────────────────────────

  describe('D5 — device-supplied sale time', () => {
    it("files the order under the device's time at Save, not the server's insert time", async () => {
      const saleTime = '2026-08-18T02:30:00.000Z'; // a Tuesday, days before this drain
      const res = await call('/orders', {
        method: 'POST',
        body: JSON.stringify(orderBody({ receipt_number: testReceipt(1), created_at: saleTime })),
      });
      const order = await res.json();
      assert.equal(new Date(order.created_at).toISOString(), saleTime);
    });

    it('omitting it keeps the server clock, as every online save does today', async () => {
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody()) });
      const order = await res.json();
      assert.ok(Date.now() - new Date(order.created_at).getTime() < 60_000);
    });
  });

  // ── D14: attribution follows the record, not the drain ────────────────────

  describe('D14 — per-record profile attribution', () => {
    it('credits the profile sent with the record, in the activity log and the stock movement', async () => {
      const { rows: [luis] } = await db.query(`SELECT id FROM users WHERE profile_key = 'luis'`);
      const receipt = testReceipt(3);

      // The drain replays Luis's Tuesday receipt. The tablet is signed in on the shared
      // account (JWT above) and could be sitting on any profile; the header is what
      // decides, and the outbox takes it from the record.
      const res = await call('/orders', {
        method: 'POST', profile: 'luis',
        body: JSON.stringify(orderBody({ receipt_number: receipt })),
      });
      const order = await res.json();

      const { rows: [activity] } = await db.query(
        `SELECT performed_by, summary FROM activity_logs
          WHERE entity_type = 'order' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [order.id]
      );
      assert.equal(activity.performed_by, luis.id);
      assert.match(activity.summary, new RegExp(receipt), 'and names the order by its receipt number');

      // The stock movement is a separate, later act (ADR 0012 — deduct at dispatch), and it
      // is credited to whoever dispatches, replayed the same way through the header.
      await call(`/orders/${receipt}/status`, {
        method: 'POST', profile: 'luis', body: JSON.stringify({ status: 'in_transit' }),
      });
      const { rows: [movement] } = await db.query(
        `SELECT performed_by FROM inventory_audit_logs WHERE related_order_id = $1 ORDER BY id DESC LIMIT 1`,
        [order.id]
      );
      assert.equal(movement.performed_by, luis.id);
      assert.notEqual(movement.performed_by, adminUserId);
    });

    it('two records drained back to back keep their own profiles', async () => {
      const { rows: [josie] } = await db.query(`SELECT id FROM users WHERE profile_key = 'josie'`);
      const { rows: [luis] } = await db.query(`SELECT id FROM users WHERE profile_key = 'luis'`);
      const one = await (await call('/orders', {
        method: 'POST', profile: 'josie',
        body: JSON.stringify(orderBody({ receipt_number: testReceipt(2) })),
      })).json();
      const two = await (await call('/orders', {
        method: 'POST', profile: 'luis',
        body: JSON.stringify(orderBody({ receipt_number: testReceipt(2) })),
      })).json();

      const { rows } = await db.query(
        `SELECT entity_id, performed_by FROM activity_logs
          WHERE entity_type = 'order' AND entity_id = ANY($1::int[]) AND action = 'created'`,
        [[one.id, two.id]]
      );
      const by = Object.fromEntries(rows.map((r) => [r.entity_id, r.performed_by]));
      assert.equal(by[one.id], josie.id);
      assert.equal(by[two.id], luis.id);
    });
  });

  // ── Piece 2: atomic adjustment on insert & resolveOrderId by receipt number ─

  describe('Piece 2 — atomic adjustment and resolveOrderId by receipt number', () => {
    it('POST /orders accepts adjustment and adjustment_reason atomically', async () => {
      const receipt = testReceipt(1);
      const res = await call('/orders', {
        method: 'POST',
        body: JSON.stringify(orderBody({
          receipt_number: receipt,
          adjustment: -50,
          adjustment_reason: 'Suki discount',
        })),
      });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, receipt);
      assert.equal(Number(order.adjustment), -50);
      assert.equal(order.adjustment_reason, 'Suki discount');
    });

    it('GET, PATCH, receipt-printed, and status routes accept receipt number in :id parameter', async () => {
      const receipt = testReceipt(1);
      const createdRes = await call('/orders', {
        method: 'POST',
        body: JSON.stringify(orderBody({ receipt_number: receipt })),
      });
      assert.equal(createdRes.status, 201);

      // GET /orders/:receipt_number
      const getRes = await call(`/orders/${receipt}`);
      assert.equal(getRes.status, 200);
      const getOrder = await getRes.json();
      assert.equal(getOrder.receipt_number, receipt);

      // POST /orders/:receipt_number/receipt-printed
      const printedRes = await call(`/orders/${receipt}/receipt-printed`, {
        method: 'POST',
        body: JSON.stringify({ phase: 'pending' }),
      });
      assert.equal(printedRes.status, 200);
      const printedOrder = await printedRes.json();
      assert.ok(printedOrder.pending_receipt_printed_at);

      // PATCH /orders/:receipt_number/adjustment
      const adjRes = await call(`/orders/${receipt}/adjustment`, {
        method: 'PATCH',
        body: JSON.stringify({ adjustment: 25, adjustment_reason: 'Delivery fee' }),
      });
      assert.equal(adjRes.status, 200);
      const adjOrder = await adjRes.json();
      assert.equal(Number(adjOrder.adjustment), 25);

      // POST /orders/:receipt_number/status
      const cancelRes = await call(`/orders/${receipt}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelledOrder = await cancelRes.json();
      assert.equal(cancelledOrder.status, 'cancelled');
    });
  });
});
