// ADR 0017 slice 7 — the human-facing half of the decision.
//
// Three things, all of which exist so that a person, not a program, can work out which
// sale a piece of paper refers to:
//
//   #10  The SELLER'S NAME IS PRINTED IN WORDS. This is the exit ramp the ADR names —
//        once "Sold by: Luis" is on the paper, the person digit leading the receipt
//        number is an optional convenience rather than the only record of who sold it.
//        The name has to come off the order row, because a receipt is printed from a
//        device that may not have been online since the sale.
//   #11  ORDER SEARCH ACCEPTS BARE DIGITS. `42` finds every order whose sequence is 42
//        across all prefixes, as a disambiguation list, because customers read digits
//        off faded thermal paper and skip the prefix.
//   #12  NEVER ORDER BY RECEIPT NUMBER. `#1240`, `3-00061` and `1A-00001` coexist
//        permanently and do not sort as text; every list orders by time.
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
const { parseBareSequence, formatDeliveryRef, parseDeliveryRef } = require('../src/lib/receiptNumbers');

describe('ADR 0017 slice 7 — Sold by, bare-digit search, and time ordering', () => {
  let server;
  let baseUrl;
  let sellerToken;
  let seller;
  let customerId;
  let otherCustomerId;
  let productId;

  // A person band this file owns outright, so a re-run against a reused database never
  // collides with another suite's rows. Same convention as the slice 2 suite.
  const PERSON_A = 61;
  const PERSON_B = 62;

  before(async () => {
    ({ rows: [seller] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE email = 'luis@leyblestore.com' LIMIT 1`
    ));
    sellerToken = jwt.sign(
      { id: seller.id, email: seller.email, role: seller.role, full_name: seller.full_name },
      process.env.JWT_SECRET
    );

    ({ rows: [{ id: customerId }] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_S7_CUSTOMER', 'regular') RETURNING id`
    ));
    ({ rows: [{ id: otherCustomerId }] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_S7_OTHER', 'regular') RETURNING id`
    ));
    ({ rows: [{ id: productId }] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ('TEST_S7_PROD', 'Beer', 'case', $1, 100, 0, 500, TRUE) RETURNING id`,
      [`SKU_S7_${Date.now()}`]
    ));

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
    const customers = [customerId, otherCustomerId];
    await db.query(
      `DELETE FROM inventory_audit_logs
        WHERE product_id = $1
           OR related_order_id IN (SELECT id FROM orders WHERE customer_id = ANY($2::int[]))`,
      [productId, customers]
    );
    await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))', [customers]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`, [customers]);
    await db.query('DELETE FROM orders WHERE customer_id = ANY($1::int[])', [customers]);
    await db.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customers]);
    await db.query('DELETE FROM products WHERE id = $1', [productId]);
  });

  function call(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
        ...(options.headers || {}),
      },
    });
  }

  const createOrder = async (over = {}) => {
    const res = await call('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1, unit_price: 100 }],
        ...over,
      }),
    });
    assert.equal(res.status, 201, `create failed: ${await res.clone().text()}`);
    return res.json();
  };

  // ── #10 — the seller's name, in words ─────────────────────────────────────

  describe('#10 — the order records who sold it, and answers with the name', () => {
    it('stamps the signed-in account on create and returns it as sold_by_name', async () => {
      const order = await createOrder({ receipt_number: `${PERSON_A}A-00701` });
      assert.equal(order.created_by, seller.id);
      assert.equal(order.sold_by_name, seller.full_name);
    });

    it('carries the name on GET /orders/:id — which is what the receipt prints from', async () => {
      const created = await createOrder({ receipt_number: `${PERSON_A}A-00702` });
      const res = await call(`/orders/${created.receipt_number}`);
      const order = await res.json();
      assert.equal(res.status, 200);
      assert.equal(order.sold_by_name, seller.full_name);
    });

    it('carries the name on the list and on the delta sync, so a reprint offline has it too', async () => {
      const created = await createOrder({ receipt_number: `${PERSON_A}A-00703` });

      const listed = await (await call(`/orders?customer_id=${customerId}&limit=200`)).json();
      const listRow = (listed.orders || listed).find((o) => o.id === created.id);
      assert.equal(listRow.sold_by_name, seller.full_name);

      const synced = await (await call('/orders/sync?limit=200')).json();
      const syncRow = synced.orders.find((o) => o.id === created.id);
      assert.equal(syncRow.sold_by_name, seller.full_name);
    });

    it('leaves a pre-042 order with no seller rather than inventing one — nothing is backfilled', async () => {
      const created = await createOrder({ receipt_number: `${PERSON_A}A-00704` });
      // Exactly the shape of every order that existed before this migration.
      await db.query('UPDATE orders SET created_by = NULL WHERE id = $1', [created.id]);
      const order = await (await call(`/orders/${created.id}`)).json();
      assert.equal(order.sold_by_name, null);
    });
  });

  // ── #11 — bare-digit search ───────────────────────────────────────────────

  describe('parseBareSequence', () => {
    it('takes the digits a customer actually reads off the paper', () => {
      assert.equal(parseBareSequence('42'), 42);
      assert.equal(parseBareSequence(' 42 '), 42);
      assert.equal(parseBareSequence('00042'), 42, 'leading zeros are the same number');
      assert.equal(parseBareSequence('#1240'), 1240, 'a legacy order is bare digits behind a hash');
    });

    it('declines anything that is not purely digits, so a name or a full number falls through', () => {
      assert.equal(parseBareSequence('1A-00042'), null);
      assert.equal(parseBareSequence('3-00061'), null);
      assert.equal(parseBareSequence('Aling Nena'), null);
      assert.equal(parseBareSequence(''), null);
      assert.equal(parseBareSequence('0'), null);
      assert.equal(parseBareSequence(null), null);
    });

    it('never throws, unlike parseReceiptNumber — a search term is not a malformed key', () => {
      assert.doesNotThrow(() => parseBareSequence('not a number'));
    });
  });

  describe('#11 — GET /orders?search=<digits> answers with every series at that sequence', () => {
    let sameSequence;

    before(async () => {
      // The same sequence, 810, issued by two different person-and-device pairs and by
      // a pre-letter slot-scheme device. This is the situation the decision is about:
      // three orders, one number, and only the customer and the date tell them apart.
      sameSequence = [
        await createOrder({ receipt_number: `${PERSON_A}A-00810` }),
        await createOrder({ receipt_number: `${PERSON_B}B-00810`, customer_id: otherCustomerId }),
        await createOrder({ receipt_number: `${PERSON_A}-00810` }),
        // Near misses a substring match would have dragged in.
        await createOrder({ receipt_number: `${PERSON_A}A-08100` }),
        await createOrder({ receipt_number: `${PERSON_A}A-00811` }),
      ];
    });

    it('returns all three orders numbered 810 and neither near miss', async () => {
      const body = await (await call('/orders?search=810&limit=200')).json();
      const rows = body.orders || body;
      const found = rows.filter((o) => sameSequence.some((s) => s.id === o.id));
      assert.equal(found.length, 3, 'exactly the three orders whose SEQUENCE is 810');
      assert.deepEqual(
        found.map((o) => o.receipt_number).sort(),
        [`${PERSON_A}-00810`, `${PERSON_A}A-00810`, `${PERSON_B}B-00810`]
      );
    });

    it('is a disambiguation list: every row carries the customer name and the date', async () => {
      const body = await (await call('/orders?search=810&limit=200')).json();
      const rows = (body.orders || body).filter((o) => sameSequence.some((s) => s.id === o.id));
      for (const row of rows) {
        assert.ok(row.customer_name, 'customer name is what tells two same-numbered orders apart');
        assert.ok(row.created_at, 'so is the date');
      }
      assert.ok(
        new Set(rows.map((r) => r.customer_name)).size > 1,
        'the fixture really does span two customers'
      );
    });

    it('treats a zero-padded term as the same number', async () => {
      const padded = await (await call('/orders?search=00810&limit=200')).json();
      const bare = await (await call('/orders?search=810&limit=200')).json();
      assert.deepEqual(
        (padded.orders || padded).map((o) => o.id).sort(),
        (bare.orders || bare).map((o) => o.id).sort()
      );
    });

    it('finds a legacy order by its row id, which is the only number it has', async () => {
      const legacy = await createOrder({ receipt_number: `${PERSON_A}A-00812` });
      // Every pre-V2.5 order: no receipt number at all, addressed by row id forever.
      await db.query(
        'UPDATE orders SET receipt_station = NULL, receipt_device = NULL, receipt_sequence = NULL WHERE id = $1',
        [legacy.id]
      );
      const body = await (await call(`/orders?search=${legacy.id}&limit=200`)).json();
      const rows = body.orders || body;
      assert.ok(rows.some((o) => o.id === legacy.id));
    });

    it('still takes a full receipt number, and a customer name, unchanged', async () => {
      const byNumber = await (await call(`/orders?search=${PERSON_B}B-00810&limit=200`)).json();
      assert.deepEqual(
        (byNumber.orders || byNumber).map((o) => o.receipt_number),
        [`${PERSON_B}B-00810`]
      );

      const byName = await (await call('/orders?search=TEST_S7_OTHER&limit=200')).json();
      const named = byName.orders || byName;
      assert.ok(named.length > 0);
      assert.ok(named.every((o) => o.customer_name === 'TEST_S7_OTHER'));
    });
  });

  // ── #12 — never order by receipt number ───────────────────────────────────

  describe('#12 — every list orders by time, never by receipt number', () => {
    it('returns newest-first by created_at even when the numbers sort the other way', async () => {
      // Deliberately adversarial: the OLDEST sale carries the HIGHEST-sorting number,
      // so a text sort on receipt_number would put it first. The three shapes that
      // coexist permanently are all here.
      const older = await createOrder({
        receipt_number: `${PERSON_A}Z-00999`,
        created_at: '2026-01-02T03:00:00.000Z',
      });
      const newer = await createOrder({
        receipt_number: `${PERSON_A}-00001`,
        created_at: '2026-06-02T03:00:00.000Z',
      });

      const body = await (await call(`/orders?customer_id=${customerId}&limit=200`)).json();
      const rows = body.orders || body;
      const olderAt = rows.findIndex((o) => o.id === older.id);
      const newerAt = rows.findIndex((o) => o.id === newer.id);
      assert.ok(olderAt > -1 && newerAt > -1);
      assert.ok(newerAt < olderAt, 'the later SALE comes first, whatever its number sorts as');

      const dates = rows.map((o) => new Date(o.created_at).getTime());
      assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'the whole page is time-ordered');
    });
  });

  // ── #14 — delivery references take the same shape ─────────────────────────

  describe('#14 — a delivery reference is a receipt number with DEL in the middle', () => {
    it('formats and parses the letter form, and keeps the pre-letter form working', () => {
      assert.equal(formatDeliveryRef(1, 7, 'A'), '1A-DEL-00007');
      assert.equal(formatDeliveryRef(1, 7), '1-DEL-00007');
      assert.deepEqual(parseDeliveryRef('1A-DEL-00007'), { station: 1, device: 'A', sequence: 7 });
      assert.deepEqual(parseDeliveryRef('1-DEL-00007'), { station: 1, device: null, sequence: 7 });
    });

    it('is never mistaken for a bare sequence, so a delivery cannot be searched as an order', () => {
      assert.equal(parseBareSequence('1A-DEL-00007'), null);
    });
  });
});
