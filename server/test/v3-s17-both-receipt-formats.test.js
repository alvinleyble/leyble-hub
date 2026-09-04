// ADR 0017 slice 2 — the server accepts BOTH receipt-number formats.
//
// This is step 1 of the switchover ordering in ADR 0014's ADR-0017 section, and it is
// the one hard development ordering constraint in the whole build. Tablets are updated
// one at a time over several days: an un-updated tablet is still issuing `3-00061`, an
// updated one may still be holding unsynced `3-00061` receipts from before it was
// updated, and both must drain. So the server has to take both shapes before any
// device can emit a letter, and old-format acceptance is never removed (ADR 0017 #12).
//
// Nothing visible changes in this slice. No letters are allocated here — that is a
// later slice; this file only proves the server takes one when it arrives.
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
const {
  parseReceiptNumber, formatReceiptNumber, parseDeliveryRef, formatDeliveryRef,
} = require('../src/lib/receiptNumbers');
const {
  assertIssuableStation, MAX_ISSUABLE_STATION,
} = require('../src/lib/stationSlots');

describe('ADR 0017 slice 2 — both receipt-number formats are accepted', () => {
  let server;
  let baseUrl;
  let authToken;
  let customerId;
  let productId;

  before(async () => {
    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE email = 'alvin@leyblestore.com' LIMIT 1`
    );
    authToken = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, full_name: admin.full_name },
      process.env.JWT_SECRET
    );

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_S17_CUSTOMER', 'regular') RETURNING id`
    );
    customerId = customer.id;

    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('TEST_S17_PROD', 'Beer', 'case', $1, 100, 0, 500, TRUE) RETURNING id`,
      [`SKU_S17_${Date.now()}`]
    );
    productId = product.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
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
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
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

  // Vary the SEQUENCE, never the person number, so re-runs against a reused database do
  // not collide with their own earlier rows. The person numbers live in a 41+ band that
  // no other suite writes, so this file cannot collide with theirs either — and every
  // one of them is above ADR 0016's old cap of 3, which is itself the point (#13).
  let sequenceSeed = Date.now() % 70000;
  const nextSequence = () => ++sequenceSeed;

  const orderBody = (over = {}) => ({
    customer_id: customerId,
    items: [{ product_id: productId, quantity: 1, unit_price: 100 }],
    ...over,
  });

  // ── The parsers ───────────────────────────────────────────────────────────

  describe('parseReceiptNumber / parseDeliveryRef take all the shapes that exist', () => {
    it('parses the pre-letter slot scheme, unchanged', () => {
      assert.deepEqual(parseReceiptNumber('3-00061'), { station: 3, device: null, sequence: 61 });
      assert.equal(formatReceiptNumber(3, 61), '3-00061');
    });

    it('parses the person-and-device-letter scheme', () => {
      assert.deepEqual(parseReceiptNumber('3A-00001'), { station: 3, device: 'A', sequence: 1 });
      assert.equal(formatReceiptNumber(3, 1, 'A'), '3A-00001');
    });

    it('normalises the letter to upper case, so casing can never split one series in two', () => {
      assert.equal(parseReceiptNumber('3a-00001').device, 'A');
      assert.equal(formatReceiptNumber(3, 1, 'a'), '3A-00001');
    });

    it('takes a two-letter device, for a person who outlives 26 devices', () => {
      assert.deepEqual(parseReceiptNumber('1AB-00009'), { station: 1, device: 'AB', sequence: 9 });
    });

    it('takes both delivery-reference shapes and keeps DEL out of the receipt series', () => {
      assert.deepEqual(parseDeliveryRef('1-DEL-00007'), { station: 1, device: null, sequence: 7 });
      assert.deepEqual(parseDeliveryRef('1A-DEL-00007'), { station: 1, device: 'A', sequence: 7 });
      assert.equal(formatDeliveryRef(1, 7, 'A'), '1A-DEL-00007');
      // A delivery reference must never parse as a receipt number, in either shape.
      assert.throws(() => parseReceiptNumber('1-DEL-00007'), /Malformed receipt_number/);
      assert.throws(() => parseReceiptNumber('1A-DEL-00007'), /Malformed receipt_number/);
    });

    it('still refuses what was always malformed, rather than dropping it silently', () => {
      for (const bad of ['abc', 'A-00001', '1ABC-00001', '1A_00001', '0A-00001', '1A-0', '']) {
        assert.throws(() => parseReceiptNumber(bad), /Malformed receipt_number|must be a string/, bad);
      }
    });
  });

  // ── assertIssuableStation, widened (ADR 0017 #13) ─────────────────────────

  describe('assertIssuableStation is widened past ADR 0016 three slots', () => {
    it('accepts a fourth person, and everything up to the sanity ceiling', () => {
      for (const n of [1, 3, 4, 12, MAX_ISSUABLE_STATION]) {
        assert.doesNotThrow(() => assertIssuableStation(n), `person ${n}`);
      }
    });

    it('still refuses what cannot be a person at all', () => {
      for (const n of [0, -1, 1.5, MAX_ISSUABLE_STATION + 1, NaN]) {
        assert.throws(() => assertIssuableStation(n), (err) => err.status === 400, String(n));
      }
    });
  });

  // ── The route (POST /orders) ──────────────────────────────────────────────

  describe('POST /orders during the switchover window', () => {
    it('takes an old-format number from a tablet that has not been updated yet', async () => {
      const receipt = formatReceiptNumber(41, nextSequence());
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, receipt);
      assert.equal(order.receipt_device, null, 'a pre-letter receipt stores a blank letter, never a placeholder');
    });

    it('takes a new-format number from a tablet that has been updated', async () => {
      const seq = nextSequence();
      const receipt = formatReceiptNumber(41, seq, 'A');
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.receipt_number, receipt);
      assert.equal(order.receipt_device, 'A');
      assert.equal(order.receipt_station, 41);
      assert.equal(Number(order.receipt_sequence), seq);
    });

    it('a resend of a lettered number is a SUCCESS and leaves exactly one row', async () => {
      const receipt = formatReceiptNumber(42, nextSequence(), 'B');
      const first = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(first.status, 201);
      const created = await first.json();

      const second = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(second.status, 200, 'a resend must be answered so the device clears its outbox');
      assert.equal((await second.json()).id, created.id);

      const { rows } = await db.query(
        `SELECT id FROM orders WHERE receipt_station = 42 AND receipt_device = 'B' AND receipt_sequence = $1`,
        [sequenceSeed]
      );
      assert.equal(rows.length, 1);
    });

    it('two overlapping drains of the same lettered number still leave one row', async () => {
      const receipt = formatReceiptNumber(43, nextSequence(), 'C');
      const [a, b] = await Promise.all([
        call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) }),
        call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) }),
      ]);
      assert.ok(a.ok && b.ok);
      assert.equal((await a.json()).id, (await b.json()).id);
    });

    // THE point of the letter. Two of one person's devices number independently from
    // 00001, so the same digits recur — they are different sales and must not be
    // collapsed into one another by the anti-duplicate key.
    it('44-00061, 44A-00061 and 44B-00061 are three different orders, not three sends of one', async () => {
      const seq = nextSequence();
      const refs = [
        formatReceiptNumber(44, seq),
        formatReceiptNumber(44, seq, 'A'),
        formatReceiptNumber(44, seq, 'B'),
      ];
      const created = [];
      for (const receipt of refs) {
        const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
        assert.equal(res.status, 201, receipt);
        created.push(await res.json());
      }
      assert.deepEqual(created.map((o) => o.receipt_number), refs);
      assert.equal(new Set(created.map((o) => o.id)).size, 3);
    });

    it('accepts a fourth person, whose first sale ADR 0016 would have refused', async () => {
      const receipt = formatReceiptNumber(45, nextSequence(), 'A');
      const res = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).receipt_number, receipt);
    });
  });

  // ── Where this slice meets slice 1's retry key (ADR 0017 #9) ──────────────
  //
  // Slice 1 made `request_key` the retry key and made a receipt-number collision a
  // loud 409 instead of silent data loss. That 409 fires off the receipt-number unique
  // index — the one migration 040 rebuilt — so the letter has to be part of what
  // "collision" means, or two of one person's devices would 409 each other on their
  // independently-numbered `00001`s.

  describe('the device letter and the retry key together', () => {
    const withKey = (over) => orderBody({ request_key: `s17-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ...over });

    it('two devices numbering from the same sequence do not collide, each with its own retry key', async () => {
      const seq = nextSequence();
      const a = await call('/orders', { method: 'POST', body: JSON.stringify(withKey({ receipt_number: formatReceiptNumber(50, seq, 'A') })) });
      const b = await call('/orders', { method: 'POST', body: JSON.stringify(withKey({ receipt_number: formatReceiptNumber(50, seq, 'B') })) });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201, 'a different letter is a different receipt, not a collision');
      assert.notEqual((await a.json()).id, (await b.json()).id);
    });

    it('a genuine collision on one lettered number is still the loud 409, not a silent merge', async () => {
      const receipt = formatReceiptNumber(50, nextSequence(), 'A');
      const first = await call('/orders', { method: 'POST', body: JSON.stringify(withKey({ receipt_number: receipt })) });
      assert.equal(first.status, 201);

      // A DIFFERENT record — its own retry key — wearing a receipt number already stored.
      const second = await call('/orders', { method: 'POST', body: JSON.stringify(withKey({ receipt_number: receipt })) });
      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /already used by a different order/);
    });

    it('a retry of the same record is still one order and a 200, letter and all', async () => {
      const body = withKey({ receipt_number: formatReceiptNumber(50, nextSequence(), 'C') });
      const first = await call('/orders', { method: 'POST', body: JSON.stringify(body) });
      const retry = await call('/orders', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(first.status, 201);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).id, (await first.json()).id);
    });

    it('the pre-039 fallback — no retry key at all — still dedupes on the full lettered number', async () => {
      const receipt = formatReceiptNumber(51, nextSequence(), 'A');
      const first = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      const again = await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: receipt })) });
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal((await again.json()).id, (await first.json()).id);
    });
  });

  // ── Reading an order back by any of the three shapes (ADR 0010) ────────────

  describe('resolveOrderId addresses an order by all three shapes', () => {
    it('finds an order by its lettered receipt number, its pre-letter one, and its row id', async () => {
      const seq = nextSequence();
      const plain = formatReceiptNumber(46, seq);
      const lettered = formatReceiptNumber(46, seq, 'A');

      const plainOrder = await (await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: plain })) })).json();
      const letteredOrder = await (await call('/orders', { method: 'POST', body: JSON.stringify(orderBody({ receipt_number: lettered })) })).json();

      const byPlain = await (await call(`/orders/${plain}`)).json();
      const byLettered = await (await call(`/orders/${lettered}`)).json();
      const byId = await (await call(`/orders/${letteredOrder.id}`)).json();

      assert.equal(byPlain.id, plainOrder.id, 'a pre-letter lookup must never land on the lettered row');
      assert.equal(byLettered.id, letteredOrder.id);
      assert.equal(byId.id, letteredOrder.id);
    });

    it('a legacy order carrying no receipt number is still addressed by its row id', async () => {
      const created = await (await call('/orders', { method: 'POST', body: JSON.stringify(orderBody()) })).json();
      assert.equal(created.receipt_number, null);
      const readBack = await (await call(`/orders/${created.id}`)).json();
      assert.equal(readBack.id, created.id);
    });
  });

  // ── The database rule the whole slice rests on ────────────────────────────
  //
  // Once a blank letter is possible, a naive (station, device, sequence) unique index
  // SILENTLY stops protecting every pre-letter row, because SQL treats NULLs as
  // distinct. Migration 040 folds the blank letter through COALESCE inside the index
  // expression. This is invisible from the app, so it is asserted in SQL here.

  describe('migration 040 — the unique index still protects pre-letter rows', () => {
    const insert = (station, device, sequence) => db.query(
      `INSERT INTO orders (customer_id, order_type, status, total_amount,
                           receipt_station, receipt_device, receipt_sequence)
       VALUES ($1, 'delivery', 'pending', 0, $2, $3, $4) RETURNING id`,
      [customerId, station, device, sequence]
    );

    it('refuses a second row carrying an already-stored PRE-LETTER number', async () => {
      const seq = nextSequence();
      await insert(47, null, seq);
      await assert.rejects(() => insert(47, null, seq), (err) => {
        assert.equal(err.code, '23505');
        assert.equal(err.constraint, 'orders_receipt_number_uniq',
          'the route tells a duplicate receipt number apart by this index name');
        return true;
      });
    });

    it('refuses a second row carrying an already-stored LETTERED number', async () => {
      const seq = nextSequence();
      await insert(47, 'A', seq);
      await assert.rejects(() => insert(47, 'A', seq), (err) => err.code === '23505');
    });

    it('lets the same digits coexist under different letters', async () => {
      const seq = nextSequence();
      await insert(48, null, seq);
      await insert(48, 'A', seq);
      await insert(48, 'B', seq);
      const { rows } = await db.query(
        'SELECT receipt_number FROM orders WHERE receipt_station = 48 AND receipt_sequence = $1 ORDER BY id',
        [seq]
      );
      assert.deepEqual(rows.map((r) => r.receipt_number), [
        `48-${String(seq).padStart(5, '0')}`,
        `48A-${String(seq).padStart(5, '0')}`,
        `48B-${String(seq).padStart(5, '0')}`,
      ]);
    });

    it('leaves rows with no receipt number at all out of the index entirely', async () => {
      await insert(null, null, null);
      await insert(null, null, null);
    });

    it('refuses a letter without the person number it qualifies', async () => {
      await assert.rejects(() => insert(null, 'A', null), (err) => err.code === '23514');
    });

    it('refuses a letter that is not a letter', async () => {
      await assert.rejects(() => insert(49, '1', nextSequence()), (err) => err.code === '23514');
      await assert.rejects(() => insert(49, 'a', nextSequence()), (err) => err.code === '23514');
    });
  });
});
