// V2 accuracy audit — exercises the exact request sequences the V2 POS / Inventory /
// Customers screens issue, and asserts what the backend actually does with them.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const orderRoutes    = require('../src/routes/orders');
const productRoutes  = require('../src/routes/products');
const customerRoutes = require('../src/routes/customers');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('V2 accuracy audit', () => {
  let server, base, token, userId, customerId, wholesalerId;

  const api = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
  const json = async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() });

  const mkProduct = async (name, stock, price = 100, extra = {}) => {
    const { deposit_fee = 0, requires_bottle_return = false, units_per_case = 24 } = extra;
    const { rows: [p] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee,
                             current_stock, units_per_case, requires_bottle_return, is_active)
       VALUES ($1,'Beer','cs',$2,$3,$4,$5,$6,$7,TRUE) RETURNING *`,
      [name, `AUD_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, price, deposit_fee,
       stock, units_per_case, requires_bottle_return]
    );
    return p;
  };
  const stockOf = async (id) => {
    const { rows: [p] } = await db.query('SELECT current_stock FROM products WHERE id=$1', [id]);
    return Number(p.current_stock);
  };
  const auditRows = async (orderId) => {
    const { rows } = await db.query(
      'SELECT * FROM inventory_audit_logs WHERE related_order_id=$1 ORDER BY id', [orderId]);
    return rows;
  };

  before(async () => {
    let { rows: [user] } = await db.query(`SELECT id,email,full_name,role FROM users WHERE role='admin' LIMIT 1`);
    if (!user) {
      ({ rows: [user] } = await db.query(
        `INSERT INTO users (email,password_hash,full_name,role)
         VALUES ('audit@leyblestore.com','x','V2 Auditor','admin') RETURNING id,email,full_name,role`));
    }
    userId = user.id;
    token = jwt.sign({ id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET);

    ({ rows: [{ id: customerId }] } = await db.query(
      `INSERT INTO customers (name,customer_type) VALUES ('AUD_Regular','regular') RETURNING id`));
    ({ rows: [{ id: wholesalerId }] } = await db.query(
      `INSERT INTO customers (name,customer_type) VALUES ('AUD_Suki','wholesaler') RETURNING id`));

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/orders', orderRoutes);
    app.use('/api/v1/products', productRoutes);
    app.use('/api/v1/customers', customerRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ids = [customerId, wholesalerId];
    await db.query(`DELETE FROM inventory_audit_logs WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'AUD_%')
                       OR related_order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))`, [ids]);
    await db.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))`, [ids]);
    await db.query(`DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))`, [ids]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type='order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))`, [ids]);
    await db.query(`DELETE FROM orders WHERE customer_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM customer_product_prices WHERE customer_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type='customer' AND entity_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM customers WHERE id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM activity_logs WHERE entity_type='product' AND entity_id IN (SELECT id FROM products WHERE name LIKE 'AUD_%')`);
    await db.query(`DELETE FROM products WHERE name LIKE 'AUD_%'`);
  });

  // ── Amber Edit Mode (V2 sends PATCH /orders/:id with items only) ──────────────
  describe('Amber Edit Mode stock reconciliation', () => {
    it('a price-only edit moves no stock and writes no order_edit audit row', async () => {
      const p = await mkProduct('AUD_PRICE_ONLY', 40);
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 3, unit_price: 100 }] }),
      }));
      assert.equal(await stockOf(p.id), 37);

      await json(await api(`/orders/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: null, items: [{ product_id: p.id, quantity: 3, unit_price: 250 }] }),
      }));
      assert.equal(await stockOf(p.id), 37, 'price-only edit must not move stock');
      const edits = (await auditRows(order.id)).filter((r) => r.action_type === 'order_edit');
      assert.equal(edits.length, 0, 'zero net delta writes no audit row');
    });

    it('removing a line on a pending order restores exactly that line\'s stock', async () => {
      const a = await mkProduct('AUD_RM_A', 20);
      const b = await mkProduct('AUD_RM_B', 20);
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [
          { product_id: a.id, quantity: 4, unit_price: 100 },
          { product_id: b.id, quantity: 6, unit_price: 100 },
        ] }),
      }));
      assert.deepEqual([await stockOf(a.id), await stockOf(b.id)], [16, 14]);

      await json(await api(`/orders/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ product_id: a.id, quantity: 4, unit_price: 100 }] }),
      }));
      assert.deepEqual([await stockOf(a.id), await stockOf(b.id)], [16, 20]);
    });

    it('0.5-case steps reconcile exactly (no floating-point drift)', async () => {
      const p = await mkProduct('AUD_HALFCASE', 10);
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 2.5, unit_price: 100 }] }),
      }));
      assert.equal(await stockOf(p.id), 7.5);
      await json(await api(`/orders/${order.id}`, {
        method: 'PATCH', body: JSON.stringify({ items: [{ product_id: p.id, quantity: 0.5, unit_price: 100 }] }),
      }));
      assert.equal(await stockOf(p.id), 9.5);
    });

    it('the POS never blocks an oversell — stock is driven negative silently', async () => {
      const p = await mkProduct('AUD_OVERSELL', 2);
      const { status, body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 50, unit_price: 100 }] }),
      }));
      assert.equal(status, 201);
      assert.equal(await stockOf(p.id), -48);
      assert.equal(order.status, 'pending');
    });

    it('cancelling twice is rejected (422) and never double-restores stock', async () => {
      const p = await mkProduct('AUD_DOUBLE_CANCEL', 10);
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 3, unit_price: 100 }] }),
      }));
      await json(await api(`/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) }));
      assert.equal(await stockOf(p.id), 10);
      const second = await json(await api(`/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) }));
      assert.equal(second.status, 422);
      assert.equal(await stockOf(p.id), 10);
    });
  });

  // ── Draft lifecycle exactly as POSPage drives it ─────────────────────────────
  describe('Draft park / resume fidelity', () => {
    it('the adjustment round-trips through park and resume (F11)', async () => {
      // orderBody() in POSPage.jsx carries { order_type, notes, items[], customer_id }; the
      // adjustment rides its own endpoint, which the debounced draft save now also writes.
      const p = await mkProduct('AUD_DRAFT_ADJ', 30);
      const { body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft', order_type: 'pickup', notes: 'hold',
          items: [{ product_id: p.id, quantity: 2, unit_price: 100 }] }),
      }));
      assert.equal(draft.status, 'draft');
      assert.equal(Number(draft.adjustment), 0);

      // saveDraftAdjustment() in POSPage.jsx — the endpoint accepts a draft.
      const { status: adjStatus } = await json(await api(`/orders/${draft.id}/adjustment`, {
        method: 'PATCH',
        body: JSON.stringify({ adjustment: -50, adjustment_reason: 'suki discount' }),
      }));
      assert.equal(adjStatus, 200);

      // A later debounced item save (PATCH /orders/:id) must not wipe it.
      await json(await api(`/orders/${draft.id}`, { method: 'PATCH',
        body: JSON.stringify({ order_type: 'pickup', notes: 'hold',
          items: [{ product_id: p.id, quantity: 2, unit_price: 100 }] }) }));

      // Re-fetching the parked draft (what resumeDraft() does) gives the adjustment back.
      const { body: reloaded } = await json(await api(`/orders/${draft.id}`));
      assert.equal(Number(reloaded.adjustment), -50);
      assert.equal(reloaded.adjustment_reason, 'suki discount');
      assert.equal(reloaded.order_type, 'pickup');
      assert.equal(reloaded.notes, 'hold');
      assert.equal(Number(reloaded.items[0].quantity), 2);
      assert.equal(Number(reloaded.items[0].unit_price), 100);
      // The draft total stays goods-only — the adjustment lives beside it, as on any order.
      assert.equal(Number(reloaded.total_amount), 200);

      // A non-zero adjustment still demands a reason (why saveDraftAdjustment skips the
      // write while the reason box is empty).
      const { status: noReason } = await json(await api(`/orders/${draft.id}/adjustment`, {
        method: 'PATCH', body: JSON.stringify({ adjustment: -50, adjustment_reason: '' }) }));
      assert.equal(noReason, 400);
    });

    it('discarding the draft the POS is still holding breaks the in-progress order', async () => {
      const p = await mkProduct('AUD_DRAFT_DISCARD', 30);
      const { body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft',
          items: [{ product_id: p.id, quantity: 1, unit_price: 100 }] }),
      }));
      // POSDraftsModal "Discard" / "Discard all" — the live draft is in that list too.
      const del = await api(`/orders/${draft.id}`, { method: 'DELETE' });
      assert.equal(del.status, 204);

      // POSPage still holds draftId; the debounced auto-save and then Save Order both 404.
      const autosave = await json(await api(`/orders/${draft.id}`, {
        method: 'PATCH', body: JSON.stringify({ items: [{ product_id: p.id, quantity: 2, unit_price: 100 }] }) }));
      assert.equal(autosave.status, 404);
      const finalize = await json(await api(`/orders/${draft.id}/finalize`, { method: 'POST', body: '{}' }));
      assert.equal(finalize.status, 404);
      assert.equal(await stockOf(p.id), 30, 'nothing was ever committed');
    });

    it('finalizing an already-finalized order is rejected (no double deduction)', async () => {
      const p = await mkProduct('AUD_DOUBLE_FINALIZE', 20);
      const { body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft',
          items: [{ product_id: p.id, quantity: 5, unit_price: 100 }] }),
      }));
      await json(await api(`/orders/${draft.id}/finalize`, { method: 'POST', body: '{}' }));
      assert.equal(await stockOf(p.id), 15);
      const again = await json(await api(`/orders/${draft.id}/finalize`, { method: 'POST', body: '{}' }));
      assert.equal(again.status, 400);
      assert.equal(await stockOf(p.id), 15);
    });
  });

  // ── Totals ───────────────────────────────────────────────────────────────────
  describe('Order totals', () => {
    it('total_amount is goods-only while pending; the adjustment lives beside it', async () => {
      const p = await mkProduct('AUD_TOTAL_PENDING', 30, 250);
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 2, unit_price: 250 }] }),
      }));
      const { body: adjusted } = await json(await api(`/orders/${order.id}/adjustment`, {
        method: 'PATCH', body: JSON.stringify({ adjustment: -50, adjustment_reason: 'Suki discount' }) }));
      assert.equal(Number(adjusted.total_amount), 500, 'goods only');
      assert.equal(Number(adjusted.adjustment), -50);
      // What POSHistoryModal renders:
      assert.equal(Number(adjusted.total_amount) + Number(adjusted.adjustment), 450);
    });

    it('a CLOSED order folds the bottle deposit into total_amount — V2 goods-only math understates it', async () => {
      const p = await mkProduct('AUD_TOTAL_DONE', 30, 100, { deposit_fee: 5, requires_bottle_return: true, units_per_case: 24 });
      const { body: order } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [
          { product_id: p.id, quantity: 1, unit_price: 100, unit_deposit_fee: 5, units_per_case: 24 }] }),
      }));
      await json(await api(`/orders/${order.id}/adjustment`, {
        method: 'PATCH', body: JSON.stringify({ adjustment: 20, adjustment_reason: 'delivery fee' }) }));
      await json(await api(`/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) }));
      await json(await api(`/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) }));
      const { body: closed } = await json(await api(`/orders/${order.id}/close`, {
        method: 'POST', body: JSON.stringify({ items: [{ id: order.items[0].id, bottles_returned: 4 }] }) }));

      assert.equal(closed.status, 'done');
      // 20 un-returned bottles x PHP5 = 100 deposit, on top of PHP100 goods
      assert.equal(Number(closed.total_amount), 200);

      const v1Total = Number(closed.total_amount) + Number(closed.adjustment);          // OrderDetailPage
      const v2Total = Number(closed.items[0].quantity) * Number(closed.items[0].unit_price)
                    + Number(closed.adjustment);                                        // posMath.orderTotals
      assert.equal(v1Total, 220);
      assert.equal(v2Total, 120);
      assert.notEqual(v1Total, v2Total);
    });
  });

  // ── Products / inventory ────────────────────────────────────────────────────
  describe('Inventory PATCH side effects', () => {
    it('an inline price edit silently zeroes a legacy deposit_fee on a non-returnable product', async () => {
      // Pre-migration-023 shape: a deposit exists but requires_bottle_return defaulted FALSE.
      const p = await mkProduct('AUD_LEGACY_DEP', 10, 100);
      await db.query('UPDATE products SET deposit_fee = 7.50, requires_bottle_return = FALSE WHERE id = $1', [p.id]);

      // InventoryV2Page InlinePriceCell sends the price and nothing else.
      const { body: updated } = await json(await api(`/products/${p.id}`, {
        method: 'PATCH', body: JSON.stringify({ base_wholesale_price: 111 }) }));
      assert.equal(Number(updated.base_wholesale_price), 111);
      assert.equal(Number(updated.deposit_fee), 0, 'deposit silently coerced to 0');

      const { rows } = await db.query(
        `SELECT field_changed, reason FROM inventory_audit_logs WHERE product_id=$1 ORDER BY id`, [p.id]);
      const depRow = rows.find((r) => r.field_changed === 'deposit_fee');
      assert.ok(depRow, 'the coercion is audit-logged');
      assert.equal(depRow.reason, null, 'with no reason, because the inline cell sends none');
      const priceRow = rows.find((r) => r.field_changed === 'base_wholesale_price');
      assert.equal(priceRow.reason, null, 'inline price edits are audit-logged with reason NULL');
    });

    it('toggling `w/ dep` off then on loses the deposit amount (documented, verified)', async () => {
      const p = await mkProduct('AUD_DEP_TOGGLE', 10, 100, { deposit_fee: 6, requires_bottle_return: true });
      await json(await api(`/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ requires_bottle_return: false }) }));
      const { body: back } = await json(await api(`/products/${p.id}`, {
        method: 'PATCH', body: JSON.stringify({ requires_bottle_return: true }) }));
      assert.equal(Number(back.deposit_fee), 0);
    });

    it('the details-form Save Changes path writes stock with NO reason, bypassing the drawer gate', async () => {
      const p = await mkProduct('AUD_STOCK_BACKDOOR', 10, 100);
      await json(await api(`/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: p.name, unit: 'cs', base_wholesale_price: 100, deposit_fee: 0,
          units_per_case: 24, current_stock: 99, is_active: true, requires_bottle_return: false }),
      }));
      const { rows } = await db.query(
        `SELECT reason, delta FROM inventory_audit_logs WHERE product_id=$1 AND field_changed='current_stock'`, [p.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, null);
      assert.equal(Number(rows[0].delta), 89);
    });

    it('batch-price rejects negatives and duplicate ids, and skips no-op rows in the audit log', async () => {
      const a = await mkProduct('AUD_BATCH_A', 5, 100);
      const b = await mkProduct('AUD_BATCH_B', 5, 200);
      const neg = await json(await api('/products/batch-price', {
        method: 'PATCH', body: JSON.stringify({ updates: [{ id: a.id, new_price: -1 }], reason: 'x' }) }));
      assert.equal(neg.status, 400);
      const dup = await json(await api('/products/batch-price', {
        method: 'PATCH', body: JSON.stringify({ updates: [{ id: a.id, new_price: 1 }, { id: a.id, new_price: 2 }], reason: 'x' }) }));
      assert.equal(dup.status, 400);
      const ok = await json(await api('/products/batch-price', {
        method: 'PATCH', body: JSON.stringify({ updates: [
          { id: a.id, new_price: 110 }, { id: b.id, new_price: 200 }], reason: '10% Coke increase' }) }));
      assert.equal(ok.status, 200);
      const { rows } = await db.query(
        `SELECT product_id, reason FROM inventory_audit_logs WHERE product_id = ANY($1) AND field_changed='base_wholesale_price'`,
        [[a.id, b.id]]);
      assert.equal(rows.length, 1, 'the unchanged product logs nothing');
      assert.equal(rows[0].product_id, a.id);
      assert.equal(rows[0].reason, 'Batch update: 10% Coke increase');
    });
  });

  // ── Suki pricing ────────────────────────────────────────────────────────────
  describe('Suki custom pricing', () => {
    it('prices are channel-scoped and append-only — the newest row per product wins', async () => {
      const p = await mkProduct('AUD_SUKI', 10, 300);
      await json(await api(`/customers/${wholesalerId}/prices`, {
        method: 'POST', body: JSON.stringify({ product_id: p.id, custom_unit_price: 280, order_type: 'delivery' }) }));
      await json(await api(`/customers/${wholesalerId}/prices`, {
        method: 'POST', body: JSON.stringify({ product_id: p.id, custom_unit_price: 260, order_type: 'delivery' }) }));
      await json(await api(`/customers/${wholesalerId}/prices`, {
        method: 'POST', body: JSON.stringify({ product_id: p.id, custom_unit_price: 290, order_type: 'pickup' }) }));

      const { body: delivery } = await json(await api(`/customers/${wholesalerId}/prices?order_type=delivery`));
      const { body: pickup }   = await json(await api(`/customers/${wholesalerId}/prices?order_type=pickup`));
      assert.equal(delivery.filter((r) => r.product_id === p.id).length, 1);
      assert.equal(Number(delivery.find((r) => r.product_id === p.id).custom_unit_price), 260);
      assert.equal(Number(pickup.find((r) => r.product_id === p.id).custom_unit_price), 290);
    });

    it('a custom price can be saved for a REGULAR customer and is then served back', async () => {
      // POSSavePriceModal is supposed to be the only path that writes one, and it converts
      // the customer first. The endpoint itself enforces nothing.
      const p = await mkProduct('AUD_SUKI_REGULAR', 10, 300);
      const { status } = await json(await api(`/customers/${customerId}/prices`, {
        method: 'POST', body: JSON.stringify({ product_id: p.id, custom_unit_price: 111, order_type: 'delivery' }) }));
      assert.equal(status, 201);
      const { body: prices } = await json(await api(`/customers/${customerId}/prices?order_type=delivery`));
      assert.ok(prices.some((r) => r.product_id === p.id));
      // ...but POSPage.priceFor() ignores it entirely while customer_type is 'regular'.
      const { body: cust } = await json(await api(`/customers/${customerId}`));
      assert.equal(cust.customer_type, 'regular');
    });
  });

  // ── List/query contracts the V2 screens rely on ─────────────────────────────
  describe('GET /orders contract', () => {
    it('is capped at 200 rows — the History popup can silently truncate', async () => {
      const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int n FROM orders WHERE status='pending'`);
      const { body } = await json(await api('/orders?status=pending'));
      assert.ok(body.length <= 200);
      if (n > 200) assert.equal(body.length, 200);
    });

    it('a negative unit price is rejected end-to-end (F6)', async () => {
      const p = await mkProduct('AUD_NEGATIVE_PRICE', 10, 100);
      const { status } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 1, unit_price: -100 }] }),
      }));
      assert.equal(status, 400);
      assert.equal(await stockOf(p.id), 10, 'a rejected order deducts nothing');

      // A negative deposit fee is refused the same way.
      const { status: depStatus } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId,
          items: [{ product_id: p.id, quantity: 1, unit_price: 100, unit_deposit_fee: -5 }] }),
      }));
      assert.equal(depStatus, 400);

      // Drafts tolerate half-typed values, so they clamp to 0 rather than 400.
      const { status: draftStatus, body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft',
          items: [{ product_id: p.id, quantity: 1, unit_price: -100 }] }),
      }));
      assert.equal(draftStatus, 201);
      assert.equal(Number(draft.items[0].unit_price), 0);

      // The adjustment stays signed — it is the discount mechanism.
      const { body: ok } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, items: [{ product_id: p.id, quantity: 1, unit_price: 100 }] }),
      }));
      const { status: adjStatus } = await json(await api(`/orders/${ok.id}/adjustment`, {
        method: 'PATCH', body: JSON.stringify({ adjustment: -20, adjustment_reason: 'discount' }) }));
      assert.equal(adjStatus, 200);
    });
  });
});
