// The bottle deposit at close (migration 051). The listed price already includes every
// bottle's deposit, so a line is worth quantity × unit_price − bottles_returned ×
// unit_deposit_fee: Red Horse Grande 1L at ₱641.00 a case (₱614.00 of beer plus 6 bottles
// at ₱4.50) closes at ₱641.00 with nothing back and ₱614.00 with all six back. Before 051
// the deposit on un-returned bottles was added on top, so the same case closed at ₱668.00.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const orderRoutes = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../db/migrations/051_line_total_price_includes_deposit.sql'), 'utf8');
// The preview wraps itself in a read-only transaction of its own; inside the test's
// transaction only its statements are run.
const PREVIEW = fs.readFileSync(
  path.join(__dirname, '../db/previews/051_closed_order_totals.sql'), 'utf8')
  .replace(/^BEGIN TRANSACTION READ ONLY;$/m, '')
  .replace(/^ROLLBACK;$/m, '');

describe('Bottle deposit at close: the listed price includes it (migration 051)', () => {
  let server, base, token, customerId, rh, coke;

  const api = (p, options = {}) =>
    fetch(`${base}${p}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  const json = async (r) => ({ status: r.status, body: await r.json() });

  const mkProduct = async (name, price, deposit, upc, returnable) => {
    const { rows: [p] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee,
                             current_stock, units_per_case, requires_bottle_return, is_active)
       VALUES ($1,'Beer','cs',$2,$3,$4,500,$5,$6,TRUE) RETURNING *`,
      [name, `DEPMATH_${name}_${Date.now()}`, price, deposit, upc, returnable]);
    return p;
  };

  const rhLine = (quantity) => ({
    product_id: rh.id, quantity, unit_price: 641, unit_deposit_fee: 4.5, units_per_case: 6,
  });
  const cokeLine = (quantity) => ({
    product_id: coke.id, quantity, unit_price: 300, unit_deposit_fee: 0, units_per_case: 24,
  });

  // Create → (optional adjustment) → dispatch → deliver, the way the app does it.
  async function deliveredOrder(items, { deliveryFee, adjustment } = {}) {
    const body = { customer_id: customerId, order_type: 'delivery', items };
    if (deliveryFee !== undefined) body.delivery_fee_charged = deliveryFee;
    let { body: order } = await json(await api('/orders', { method: 'POST', body: JSON.stringify(body) }));
    if (adjustment !== undefined) {
      ({ body: order } = await json(await api(`/orders/${order.id}/adjustment`, {
        method: 'PATCH', body: JSON.stringify({ adjustment, adjustment_reason: 'Suki' }) })));
    }
    await api(`/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) });
    const { body: delivered } = await json(await api(`/orders/${order.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'completed' }) }));
    return delivered;
  }

  async function close(order, returnsByProduct) {
    const items = order.items
      .filter((i) => returnsByProduct[i.product_id] !== undefined)
      .map((i) => ({ id: i.id, bottles_returned: returnsByProduct[i.product_id] }));
    const res = await json(await api(`/orders/${order.id}/close`, {
      method: 'POST', body: JSON.stringify({ items }) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'done');
    return res.body;
  }

  // What every screen and both receipts total: the stored goods-and-credit figure plus
  // the delivery fee and adjustment, which keep joining the total as they always did.
  const collected = (o) => Number(o.total_amount)
    + (o.delivery_fee_charged == null ? 0 : Number(o.delivery_fee_charged))
    + Number(o.adjustment || 0);

  before(async () => {
    const { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE email = 'alvin@leyblestore.com'`);
    token = jwt.sign({ id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET);
    ({ rows: [{ id: customerId }] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('DEPMATH_Customer','regular') RETURNING id`));
    rh   = await mkProduct('RH_GRANDE', 641, 4.5, 6, true);
    coke = await mkProduct('COKE_8OZ', 300, 0, 24, false);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    const orders = `SELECT id FROM orders WHERE customer_id = $1`;
    await db.query(`DELETE FROM inventory_audit_logs WHERE related_order_id IN (${orders})
                       OR product_id = ANY($2)`, [customerId, [rh.id, coke.id]]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'order' AND entity_id IN (${orders})`, [customerId]);
    await db.query(`DELETE FROM request_keys WHERE entity_type = 'order' AND entity_id IN (${orders})`, [customerId]);
    await db.query(`DELETE FROM order_items WHERE order_id IN (${orders})`, [customerId]);
    await db.query(`DELETE FROM orders WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type = 'product' AND entity_id = ANY($1)`, [[rh.id, coke.id]]);
    await db.query(`DELETE FROM products WHERE id = ANY($1)`, [[rh.id, coke.id]]);
  });

  describe('closing an order', () => {
    it('with no bottles returned, the case closes at the listed ₱641.00 — the same as before closing', async () => {
      const delivered = await deliveredOrder([rhLine(1)]);
      assert.equal(Number(delivered.total_amount), 641);
      const closed = await close(delivered, { [rh.id]: 0 });
      assert.equal(Number(closed.items[0].line_total), 641);
      assert.equal(Number(closed.total_amount), 641);
    });

    it('with all six bottles returned, the case closes at ₱614.00', async () => {
      const closed = await close(await deliveredOrder([rhLine(1)]), { [rh.id]: 6 });
      assert.equal(Number(closed.items[0].line_total), 614);
      assert.equal(Number(closed.total_amount), 614);
    });

    it('with some bottles returned, only those are credited (2 cases, 5 of 12 back)', async () => {
      const closed = await close(await deliveredOrder([rhLine(2)]), { [rh.id]: 5 });
      // 2 × 641 − 5 × 4.50
      assert.equal(Number(closed.items[0].line_total), 1259.5);
      assert.equal(Number(closed.total_amount), 1259.5);
    });

    it('a multi-line order credits only the returnable line', async () => {
      const closed = await close(await deliveredOrder([rhLine(1), cokeLine(2)]), { [rh.id]: 6 });
      const byProduct = Object.fromEntries(closed.items.map((i) => [i.product_id, Number(i.line_total)]));
      assert.equal(byProduct[rh.id], 614);
      assert.equal(byProduct[coke.id], 600);
      assert.equal(Number(closed.total_amount), 1214);
    });

    it('the delivery fee and adjustment keep joining the total, with or without returns', async () => {
      const none = await close(
        await deliveredOrder([rhLine(1)], { deliveryFee: 50, adjustment: -20 }), { [rh.id]: 0 });
      assert.equal(Number(none.total_amount), 641);
      assert.equal(collected(none), 671);

      const all = await close(
        await deliveredOrder([rhLine(1)], { deliveryFee: 50, adjustment: -20 }), { [rh.id]: 6 });
      assert.equal(Number(all.total_amount), 614);
      assert.equal(collected(all), 644);
    });

    it('editing a closed order keeps its bottle credit', async () => {
      const closed = await close(await deliveredOrder([rhLine(1)]), { [rh.id]: 6 });
      const { status, body: edited } = await json(await api(`/orders/${closed.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ ...rhLine(1), unit_price: 650 }], revision: closed.revision }),
      }));
      assert.equal(status, 200, JSON.stringify(edited));
      assert.equal(Number(edited.items[0].bottles_returned), 6);
      assert.equal(Number(edited.total_amount), 650 - 27);
    });

    it('an open order with nothing returned stores the listed price on the line too', async () => {
      const { body: open } = await json(await api('/orders', {
        method: 'POST', body: JSON.stringify({ customer_id: customerId, items: [rhLine(1)] }) }));
      assert.equal(Number(open.total_amount), 641);
      assert.equal(Number(open.items[0].line_total), 641);
    });
  });

  // The migration is proved against the shape it replaces: inside one transaction the
  // 023 column is put back, orders are written the way the pre-051 server wrote them,
  // migration 051 is run twice, and everything is rolled back.
  describe('migration 051', () => {
    it('recalculates closed orders once, leaves open ones alone, and a second run changes nothing', async () => {
      const client = await db.connect();
      const notices = [];
      client.on('notice', (n) => notices.push(n.message));
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE order_items DROP COLUMN line_total`);
        await client.query(`ALTER TABLE order_items ADD COLUMN line_total NUMERIC(10,2)
          GENERATED ALWAYS AS (quantity * unit_price
            + (quantity * units_per_case - bottles_returned) * unit_deposit_fee) STORED`);

        const mkOrder = async (status, lines, extra = {}) => {
          const { rows: [o] } = await client.query(
            `INSERT INTO orders (customer_id, status, order_type, delivery_fee_charged, adjustment, closed_at)
             VALUES ($1, $2::text, 'delivery', $3, $4, CASE WHEN $2::text = 'done' THEN NOW() END) RETURNING id`,
            [customerId, status, extra.fee ?? null, extra.adjustment ?? 0]);
          for (const [product, quantity, returned] of lines) {
            const line = product === rh ? rhLine(quantity) : cokeLine(quantity);
            await client.query(
              `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee,
                                        units_per_case, bottles_returned)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [o.id, line.product_id, quantity, line.unit_price, line.unit_deposit_fee,
               line.units_per_case, returned]);
          }
          // recomputeTotal as the pre-051 server ran it.
          await client.query(
            `UPDATE orders o SET total_amount = (
               SELECT COALESCE(SUM(CASE WHEN o.status = 'done' THEN oi.line_total
                                        ELSE oi.quantity * oi.unit_price END), 0)
                 FROM order_items oi WHERE oi.order_id = o.id)
             WHERE o.id = $1`, [o.id]);
          return o.id;
        };

        const ids = {
          doneNone:  await mkOrder('done', [[rh, 1, 0]]),
          doneAll:   await mkOrder('done', [[rh, 1, 6]]),
          doneSome:  await mkOrder('done', [[rh, 2, 5]]),
          doneMulti: await mkOrder('done', [[rh, 1, 6], [coke, 2, 0]]),
          doneFees:  await mkOrder('done', [[rh, 1, 0]], { fee: 50, adjustment: -20 }),
          doneCoke:  await mkOrder('done', [[coke, 3, 0]]),
          pending:   await mkOrder('pending', [[rh, 1, 0]]),
          completed: await mkOrder('completed', [[rh, 1, 0]], { fee: 50 }),
        };
        const all = Object.values(ids);
        const snapshot = async () => {
          const { rows } = await client.query(
            `SELECT id, total_amount::float AS total, revision::text AS revision, updated_at
               FROM orders WHERE id = ANY($1)`, [all]);
          return Object.fromEntries(rows.map((r) => [r.id, r]));
        };
        const before = await snapshot();
        assert.equal(before[ids.doneNone].total, 668, 'the bug: deposit added on top of ₱641.00');
        assert.equal(before[ids.doneAll].total, 641);
        assert.equal(before[ids.doneSome].total, 1313.5);
        assert.equal(before[ids.doneMulti].total, 1241);
        assert.equal(before[ids.doneFees].total, 668);
        assert.equal(before[ids.pending].total, 641);

        // The read-only preview names exactly the orders the migration will change.
        const preview = (await client.query(PREVIEW))
          .filter((r) => r.command === 'SELECT');
        const listed = preview[0].rows.filter((r) => all.includes(r.order_id));
        assert.deepEqual(
          Object.fromEntries(listed.map((r) => [r.order_id, [Number(r.before_total), Number(r.after_total)]])),
          {
            [ids.doneNone]:  [668, 641],
            [ids.doneAll]:   [641, 614],
            [ids.doneSome]:  [1313.5, 1259.5],
            [ids.doneMulti]: [1241, 1214],
            [ids.doneFees]:  [668, 641],
          });

        notices.length = 0;
        await client.query(MIGRATION);
        const afterFirst = await snapshot();
        assert.deepEqual(
          Object.fromEntries(all.map((id) => [id, afterFirst[id].total])),
          {
            [ids.doneNone]: 641, [ids.doneAll]: 614, [ids.doneSome]: 1259.5,
            [ids.doneMulti]: 1214, [ids.doneFees]: 641, [ids.doneCoke]: 900,
            [ids.pending]: 641, [ids.completed]: 641,
          });
        // Only the five whose total moved were written: their revision advanced so every
        // tablet's delta sync picks the corrected copy up; the rest were not touched.
        for (const key of ['doneNone', 'doneAll', 'doneSome', 'doneMulti', 'doneFees']) {
          assert.notEqual(afterFirst[ids[key]].revision, before[ids[key]].revision, `${key} rewritten`);
        }
        for (const key of ['doneCoke', 'pending', 'completed']) {
          assert.equal(afterFirst[ids[key]].revision, before[ids[key]].revision, `${key} untouched`);
        }
        const { rows: lines } = await client.query(
          `SELECT order_id, line_total::float AS lt FROM order_items WHERE order_id = $1 OR order_id = $2`,
          [ids.pending, ids.completed]);
        assert.deepEqual(lines.map((l) => l.lt), [641, 641], 'open lines now carry the listed price');

        // The count is logged — this database's other closed orders may add to it, but
        // never fewer than the five written here.
        const counted = notices.map((m) => m.match(/051: recalculated the total of (\d+) closed order/))
          .filter(Boolean);
        assert.equal(counted.length, 1, notices.join(' | '));
        assert.ok(Number(counted[0][1]) >= 5);

        const previewAfter = (await client.query(PREVIEW)).filter((r) => r.command === 'SELECT');
        assert.equal(previewAfter[0].rows.filter((r) => all.includes(r.order_id)).length, 0);

        notices.length = 0;
        await client.query(MIGRATION);
        const afterSecond = await snapshot();
        assert.deepEqual(afterSecond, afterFirst, 'a second run writes nothing');
        assert.ok(notices.some((m) => m === '051: recalculated the total of 0 closed order(s)'), notices.join(' | '));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
