// Migration 052: closed orders whose bottle counts were the old close form's "all
// returned" prefill. Under migration 023's formula that prefill changed nothing; under
// 051 it would take a full bottle credit off each of them. The owners accepted the
// prefill rather than counting, so 052 resets those counts to zero and the orders keep
// the listed price they closed at. A line recorded above its full count is prefill plus
// a stray tap (live order 169) and counts as full. Partial counts — even beside a line
// that is over — orders with no deposit lines, and orders closed after 051 (through the
// new form, which defaults to 0) keep what they have.
//
// Proved the way close-deposit-math.test.js proves 051: inside one transaction the 023
// column is put back and 051's _migrations row removed, so the database is pre-051;
// orders are written the way the pre-051 server wrote them; 051 then 052 run the way
// server/db/migrate.js runs them; and everything is rolled back.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';

const db = require('../src/db');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const M051_FILE = '051_line_total_price_includes_deposit.sql';
const M051 = read(`db/migrations/${M051_FILE}`);
const M052 = read('db/migrations/052_reset_prefilled_bottle_returns.sql');
// The preview wraps itself in a read-only transaction of its own; inside the test's
// transaction only its statements are run.
const PREVIEW = read('db/previews/052_prefill_reset.sql')
  .replace(/^BEGIN TRANSACTION READ ONLY;$/m, '')
  .replace(/^ROLLBACK;$/m, '');

describe('Migration 052: reset prefilled bottle counts on closed orders', () => {
  it('resets only pre-051 all-returned orders, keeps real counts, and a second run changes nothing', async () => {
    const client = await db.connect();
    const notices = [];
    client.on('notice', (n) => notices.push(n.message));
    try {
      await client.query('BEGIN');

      // Pre-051: migration 023's line formula, and no record of 051 having run.
      await client.query(`ALTER TABLE order_items DROP COLUMN line_total`);
      await client.query(`ALTER TABLE order_items ADD COLUMN line_total NUMERIC(10,2)
        GENERATED ALWAYS AS (quantity * unit_price
          + (quantity * units_per_case - bottles_returned) * unit_deposit_fee) STORED`);
      await client.query(`DELETE FROM _migrations WHERE filename = $1`, [M051_FILE]);

      const { rows: [{ id: customerId }] } = await client.query(
        `INSERT INTO customers (name, customer_type) VALUES ('PREFILL_Customer','regular') RETURNING id`);
      const mkProduct = async (name, price, deposit, upc) => {
        const { rows: [p] } = await client.query(
          `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee,
                                 current_stock, units_per_case, requires_bottle_return, is_active)
           VALUES ($1,'Beer','cs',$2,$3,$4,500,$5,$6,TRUE) RETURNING *`,
          [name, `PREFILL_${name}_${Date.now()}`, price, deposit, upc, deposit > 0]);
        return p;
      };
      // Red Horse Grande 1L: ₱641.00 a case, 6 bottles at ₱4.50. Three more deposit
      // products (12 bottles a case) and Coke, which carries no deposit.
      const rh   = await mkProduct('RH_GRANDE', 641, 4.5, 6);
      const smb  = await mkProduct('SMB_PALE', 500, 3, 12);
      const ck   = await mkProduct('COKE_KASALO', 400, 3, 12);
      const rhl  = await mkProduct('RH_LITRO', 600, 4.5, 12);
      const coke = await mkProduct('COKE_8OZ', 300, 0, 24);

      // closedAgo: how long before now the order was closed; 051 is recorded as applied
      // one day ago, so anything older is a pre-051 close.
      const mkOrder = async (status, lines, closedAgo = '30 days') => {
        const { rows: [o] } = await client.query(
          `INSERT INTO orders (customer_id, status, order_type, closed_at)
           VALUES ($1, $2::text, 'delivery',
                   CASE WHEN $2::text = 'done' THEN NOW() - $3::interval END) RETURNING id`,
          [customerId, status, closedAgo]);
        for (const [product, quantity, returned] of lines) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee,
                                      units_per_case, bottles_returned)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [o.id, product.id, quantity, product.base_wholesale_price, product.deposit_fee,
             product.units_per_case, returned]);
        }
        // recomputeTotal: SUM(line_total) for a 'done' order, goods only while open.
        await client.query(
          `UPDATE orders o SET total_amount = (
             SELECT COALESCE(SUM(CASE WHEN o.status = 'done' THEN oi.line_total
                                      ELSE oi.quantity * oi.unit_price END), 0)
               FROM order_items oi WHERE oi.order_id = o.id)
           WHERE o.id = $1`, [o.id]);
        return o.id;
      };

      const ids = {
        allBack:      await mkOrder('done', [[rh, 1, 6]]),               // the prefill
        allBackMulti: await mkOrder('done', [[rh, 1, 6], [smb, 2, 24], [coke, 2, 0]]),
        allBackHalf:  await mkOrder('done', [[rh, 0.5, 3]]),             // half a case
        // Like live order 169: three full lines and one a bottle over (61 of 60).
        overByOne:    await mkOrder('done', [[rh, 2, 12], [smb, 1, 12], [ck, 1, 12], [rhl, 5, 61]]),
        overPartial:  await mkOrder('done', [[rh, 1, 7], [smb, 1, 5]]),  // one over, one partial
        someBack:     await mkOrder('done', [[rh, 2, 5]]),
        noneBack:     await mkOrder('done', [[rh, 1, 0]]),
        mixed:        await mkOrder('done', [[rh, 1, 6], [smb, 2, 5]]),  // one full, one partial
        noDeposit:    await mkOrder('done', [[coke, 3, 0]]),
        open:         await mkOrder('pending', [[rh, 1, 0]]),
      };
      const preIds = Object.values(ids);

      const snapshot = async (orderIds) => {
        const { rows } = await client.query(
          `SELECT o.id, o.total_amount::float AS total, o.revision::text AS revision,
                  array_agg(oi.bottles_returned ORDER BY oi.id) AS returned
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
            WHERE o.id = ANY($1) GROUP BY o.id`, [orderIds]);
        return Object.fromEntries(rows.map((r) => [r.id, r]));
      };
      const totals = (snap, keys) => Object.fromEntries(keys.map((k) => [k, snap[ids[k]].total]));
      const runPreview = async (orderIds) => {
        const [list, summary] = (await client.query(PREVIEW)).filter((r) => r.command === 'SELECT');
        const rows = list.rows.filter((r) => orderIds.includes(r.order_id));
        return {
          rows: Object.fromEntries(rows.map((r) => [r.order_id, {
            current: Number(r.current_total), final: Number(r.final_total), reset: r.counts_reset }])),
          summary: summary.rows[0],
        };
      };

      const original = await snapshot(preIds);
      const originalTotals = totals(original, Object.keys(ids));
      assert.deepEqual(originalTotals, {
        allBack: 641, allBackMulti: 2241, allBackHalf: 320.5,
        overByOne: 5177.5, overPartial: 1157.5, someBack: 1313.5,
        noneBack: 668, mixed: 1698, noDeposit: 900, open: 641,
      });

      // On a database that has run neither (production), the preview gives the combined
      // net effect of 051 then 052.
      const previewPre = await runPreview(preIds);
      const expectedPre = {
        [ids.allBack]:      { current: 641,    final: 641,    reset: true },
        [ids.allBackMulti]: { current: 2241,   final: 2241,   reset: true },
        [ids.allBackHalf]:  { current: 320.5,  final: 320.5,  reset: true },
        // The stray bottle had taken ₱4.50 off under 023; reset, it is the listed ₱5,182.00.
        [ids.overByOne]:    { current: 5177.5, final: 5182,   reset: true },
        [ids.overPartial]:  { current: 1157.5, final: 1094.5, reset: false },
        [ids.someBack]:     { current: 1313.5, final: 1259.5, reset: false },
        [ids.noneBack]:     { current: 668,    final: 641,    reset: false },
        [ids.mixed]:        { current: 1698,   final: 1599,   reset: false },
        [ids.noDeposit]:    { current: 900,    final: 900,    reset: false },
      };
      assert.deepEqual(previewPre.rows, expectedPre);

      // migrate.js: 051 runs and its _migrations row is committed before 052 is read.
      notices.length = 0;
      await client.query(M051);
      await client.query(
        `INSERT INTO _migrations (filename, applied_at) VALUES ($1, NOW() - INTERVAL '1 day')`,
        [M051_FILE]);
      const after051 = await snapshot(preIds);
      assert.deepEqual(totals(after051, Object.keys(ids)), {
        allBack: 614, allBackMulti: 2142, allBackHalf: 307,
        overByOne: 4781.5, overPartial: 1094.5, someBack: 1259.5,
        noneBack: 641, mixed: 1599, noDeposit: 900, open: 641,
      }, '051 alone credits the prefill');

      // Closed through the new form after 051: a full count was typed, so it is real.
      ids.postAll = await mkOrder('done', [[rh, 1, 6]], '1 hour');
      const allIds = Object.values(ids);
      const before052 = await snapshot(allIds);
      assert.equal(before052[ids.postAll].total, 614);

      const previewMid = await runPreview(allIds);

      notices.length = 0;
      await client.query(M052);
      const after052 = await snapshot(allIds);

      // Prefilled pre-051 orders: counts back to zero, totals back to what they closed at.
      for (const key of ['allBack', 'allBackMulti', 'allBackHalf']) {
        assert.equal(after052[ids[key]].total, originalTotals[key], `${key} keeps its original total`);
        assert.ok(after052[ids[key]].returned.every((n) => n === 0), `${key} counts reset`);
        assert.notEqual(after052[ids[key]].revision, before052[ids[key]].revision, `${key} rewritten`);
      }
      // Prefill plus a stray tap: reset too, to the full listed price.
      assert.equal(after052[ids.overByOne].total, 5182);
      assert.deepEqual(after052[ids.overByOne].returned, [0, 0, 0, 0]);
      assert.notEqual(after052[ids.overByOne].revision, before052[ids.overByOne].revision);
      // Real counts keep their count and 051's total; the rest are not written at all.
      assert.deepEqual(after052[ids.overPartial].returned, [7, 5]);
      assert.equal(after052[ids.overPartial].total, 1094.5);
      assert.deepEqual(after052[ids.someBack].returned, [5]);
      assert.deepEqual(after052[ids.mixed].returned, [6, 5]);
      assert.deepEqual(after052[ids.postAll].returned, [6]);
      for (const key of ['overPartial', 'someBack', 'noneBack', 'mixed', 'noDeposit', 'open', 'postAll']) {
        assert.deepEqual(after052[ids[key]], before052[ids[key]], `${key} untouched by 052`);
      }

      const counted = notices.map((m) => m.match(/^052: reset prefilled bottle counts on (\d+) closed order\(s\)$/))
        .filter(Boolean);
      assert.equal(counted.length, 1, notices.join(' | '));
      assert.ok(Number(counted[0][1]) >= 4, notices.join(' | '));

      // The preview's answer — before either migration, and between 051 and 052 — is the
      // end state.
      for (const id of Object.keys(previewPre.rows)) {
        assert.equal(previewPre.rows[id].final, after052[id].total, `pre-051 preview of ${id}`);
      }
      for (const id of allIds.filter((i) => i !== ids.open)) {
        assert.equal(previewMid.rows[id].final, after052[id].total, `mid preview of ${id}`);
        assert.equal(previewMid.rows[id].reset,
          [ids.allBack, ids.allBackMulti, ids.allBackHalf, ids.overByOne].includes(id),
          `mid preview reset of ${id}`);
      }
      const previewEnd = await runPreview(allIds);
      for (const row of Object.values(previewEnd.rows)) {
        assert.equal(row.final, row.current);
        assert.equal(row.reset, false);
      }
      assert.equal(Number(previewEnd.summary.orders_reset), 0);

      // A second run changes nothing.
      notices.length = 0;
      await client.query(M052);
      assert.deepEqual(await snapshot(allIds), after052, 'a second run writes nothing');
      assert.ok(notices.includes('052: reset prefilled bottle counts on 0 closed order(s)'), notices.join(' | '));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
