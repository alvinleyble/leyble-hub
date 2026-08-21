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

    it('the reviewed draft holds no stock, and discarding it leaves nothing behind', async () => {
      // POSPage handleReview: the cart is flushed onto the draft and reviewed there.
      const p = await mkProduct('AUD_REVIEW_DISCARD', 30);
      const { body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft',
          items: [{ product_id: p.id, quantity: 3, unit_price: 100 }] }),
      }));
      await json(await api(`/orders/${draft.id}`, { method: 'PATCH',
        body: JSON.stringify({ items: [{ product_id: p.id, quantity: 4, unit_price: 100 }] }) }));
      assert.equal(await stockOf(p.id), 30, 'reviewing a draft moves no stock');

      // POSReviewModal "Discard" — V1's handleDiscard, byte for byte.
      const del = await api(`/orders/${draft.id}`, { method: 'DELETE' });
      assert.equal(del.status, 204);

      const gone = await api(`/orders/${draft.id}`);
      assert.equal(gone.status, 404, 'the draft is really gone, not cancelled');
      assert.equal(await stockOf(p.id), 30, 'nothing to restore, because nothing was taken');
      assert.equal((await auditRows(draft.id)).length, 0, 'no stock audit rows at all');
      const { rows: acts } = await db.query(
        `SELECT 1 FROM activity_logs WHERE entity_type='order' AND entity_id=$1`, [draft.id]);
      assert.equal(acts.length, 0, 'an abandoned draft is not a business event');
    });

    it('confirming the reviewed draft is what creates the order and deducts the stock', async () => {
      const p = await mkProduct('AUD_REVIEW_CONFIRM', 30);
      const { body: draft } = await json(await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId, status: 'draft',
          items: [{ product_id: p.id, quantity: 4, unit_price: 100 }] }),
      }));
      await json(await api(`/orders/${draft.id}/adjustment`, { method: 'PATCH',
        body: JSON.stringify({ adjustment: -40, adjustment_reason: 'suki discount' }) }));
      assert.equal(await stockOf(p.id), 30);

      // POSReviewModal "Confirm & Print".
      const { status, body: created } = await json(
        await api(`/orders/${draft.id}/finalize`, { method: 'POST', body: '{}' }));
      assert.equal(status, 200);
      assert.equal(created.id, draft.id, 'the number reviewed is the number printed');
      assert.equal(created.status, 'pending');
      assert.equal(await stockOf(p.id), 26, 'stock moves at confirm, not before');
      // The adjustment parked on the draft survives the finalize (F11).
      assert.equal(Number(created.adjustment), -40);
      assert.equal(created.adjustment_reason, 'suki discount');
      assert.equal(Number(created.total_amount), 400, 'total stays goods-only');
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
=======
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const customerRoutes = require('../src/routes/customers');
const orderRoutes = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('V2 Customer Accuracy & Correctness Audit Tests (F4 & F10)', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let testCustomerId;
  let testProductId;

  before(async () => {
    // Admin user
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-audit@leyblestore.com', 'dummyhash', 'Audit Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    testUserId = user.id;

    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    // Test customer
    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('Audit Test Customer', 'regular', '789 Audit Way', '09112223334')
       RETURNING id`
    );
    testCustomerId = customer.id;

    // Test product with returnable bottle deposit
    const sku = `SKU_AUDIT_${Date.now()}`;
    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, units_per_case, requires_bottle_return, current_stock, is_active)
       VALUES ('TEST_PROD_AUDIT_BEER', 'Beer', 'case', $1, 100.00, 2.50, 24, TRUE, 100, TRUE)
       RETURNING *`,
      [sku]
    );
    testProductId = product.id;

    // Express app setup
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/customers', customerRoutes);
    app.use('/api/v1/orders', orderRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (testCustomerId) {
      await db.query(`
        DELETE FROM inventory_audit_logs
        WHERE product_id = $1
           OR (related_order_id IS NOT NULL AND related_order_id IN (SELECT id FROM orders WHERE customer_id = $2))
      `, [testProductId, testCustomerId]);

      await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [testCustomerId]);
      await db.query('DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [testCustomerId]);
      await db.query('DELETE FROM activity_logs WHERE entity_id IN (SELECT id FROM orders WHERE customer_id = $1) AND entity_type = \'order\'', [testCustomerId]);
      await db.query('DELETE FROM orders WHERE customer_id = $1', [testCustomerId]);
      await db.query('DELETE FROM customers WHERE id = $1', [testCustomerId]);
    }
    if (testProductId) {
      await db.query('DELETE FROM products WHERE id = $1', [testProductId]);
    }
  });

  function api(endpoint, options = {}) {
    return fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        ...(options.headers || {}),
      },
    });
  }

  it('F4 — GET /customers/:id includes adjustment and adjustment_reason in order history', async () => {
    // Create an order
    const orderRes = await api('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: testCustomerId,
        order_type: 'delivery',
        status: 'pending',
        items: [
          {
            product_id: testProductId,
            quantity: 2,
            unit_price: 100.00,
            unit_deposit_fee: 2.50,
            units_per_case: 24,
          },
        ],
      }),
    });
    assert.equal(orderRes.status, 201);
    const order = await orderRes.json();

    // Set adjustment
    const adjRes = await api(`/orders/${order.id}/adjustment`, {
      method: 'PATCH',
      body: JSON.stringify({
        adjustment: -25.00,
        adjustment_reason: 'Audit Suki Discount',
      }),
    });
    assert.equal(adjRes.status, 200);

    // Call GET /customers/:id
    const custRes = await api(`/customers/${testCustomerId}`);
    assert.equal(custRes.status, 200);
    const customerData = await custRes.json();

    const foundOrder = customerData.orders.find((o) => o.id === order.id);
    assert.ok(foundOrder, 'Order should be present in customer order history');
    assert.equal(Number(foundOrder.adjustment), -25.00, 'Adjustment should match');
    assert.equal(foundOrder.adjustment_reason, 'Audit Suki Discount', 'Adjustment reason should match');

    // Customer drawer row total computation verification:
    const rowTotal = Number(foundOrder.total_amount) + Number(foundOrder.adjustment || 0);
    // Goods total is 2 * 100 = 200, adjustment is -25 -> rowTotal is 175
    assert.equal(rowTotal, 175.00);
  });

  it('F4 — Closed order includes bottle deposit in totals while completed/pending stay goods-only', async () => {
    // Create pending order: 2 cases @ 100/cs = 200 goods, deposit_fee 2.50, units_per_case 24 (48 bottles = 120 deposit)
    const createRes = await api('/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: testCustomerId,
        order_type: 'delivery',
        status: 'pending',
        items: [
          {
            product_id: testProductId,
            quantity: 2,
            unit_price: 100.00,
            unit_deposit_fee: 2.50,
            units_per_case: 24,
          },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const pendingOrder = await createRes.json();

    // Set adjustment
    await api(`/orders/${pendingOrder.id}/adjustment`, {
      method: 'PATCH',
      body: JSON.stringify({
        adjustment: 10.00,
        adjustment_reason: 'Handling fee',
      }),
    });

    // While pending: total_amount in DB is 200.00 (goods-only)
    const { rows: [pendingRow] } = await db.query('SELECT total_amount FROM orders WHERE id = $1', [pendingOrder.id]);
    assert.equal(Number(pendingRow.total_amount), 200.00);

    // Advance pending -> in_transit -> completed
    const transitRes = await api(`/orders/${pendingOrder.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'in_transit' }),
    });
    assert.equal(transitRes.status, 200);

    const completeRes = await api(`/orders/${pendingOrder.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(completeRes.status, 200);
    const completedOrder = await completeRes.json();

    // While completed: total_amount in DB is still 200.00 (goods-only)
    assert.equal(Number(completedOrder.total_amount), 200.00);

    // Modal calculation logic for completed order:
    // Goods: 200.00, Deposit: 0.00 (open/completed), Adjustment: 10.00 -> Total: 210.00
    const isCompletedClosed = completedOrder.status === 'done';
    assert.equal(isCompletedClosed, false);
    const completedGoods = completedOrder.items.reduce((s, i) => s + (Number(i.quantity) * Number(i.unit_price)), 0);
    const completedDeposit = isCompletedClosed
      ? completedOrder.items.reduce((s, i) => s + ((Number(i.quantity) * Number(i.units_per_case) - Number(i.bottles_returned)) * Number(i.unit_deposit_fee)), 0)
      : 0;
    const completedTotal = completedGoods + completedDeposit + Number(completedOrder.adjustment || 0);
    assert.equal(completedGoods, 200.00);
    assert.equal(completedDeposit, 0.00);
    assert.equal(completedTotal, 210.00);

    // Close order (0 bottles returned -> deposit owed = 48 * 2.50 = 120.00)
    const closeRes = await api(`/orders/${pendingOrder.id}/close`, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { id: pendingOrder.items[0].id, bottles_returned: 0 },
        ],
      }),
    });
    assert.equal(closeRes.status, 200);
    const closedOrder = await closeRes.json();

    // Closed order status is 'done' and total_amount in DB is 320.00 (goods 200 + deposit 120)
    assert.equal(closedOrder.status, 'done');
    assert.equal(Number(closedOrder.total_amount), 320.00);

    // Modal calculation logic for closed order:
    // Goods: 200.00, Deposit: 120.00, Adjustment: 10.00 -> Total: 330.00
    const items = closedOrder.items;
    const isClosed = closedOrder.status === 'done';
    assert.equal(isClosed, true);
    const goods = items.reduce((s, i) => s + (Number(i.quantity) * Number(i.unit_price)), 0);
    const deposit = isClosed
      ? items.reduce((s, i) => s + ((Number(i.quantity) * Number(i.units_per_case) - Number(i.bottles_returned)) * Number(i.unit_deposit_fee)), 0)
      : 0;
    const total = goods + deposit + Number(closedOrder.adjustment || 0);

    assert.equal(goods, 200.00);
    assert.equal(deposit, 120.00);
    assert.equal(total, 330.00);

    // Over-return scenario (e.g. 58 bottles returned for 48 ordered -> -10 unreturned -> -25 deposit credit)
    const overReturnedItems = [{ ...closedOrder.items[0], bottles_returned: 58 }];
    const overDeposit = overReturnedItems.reduce((s, i) => s + ((Number(i.quantity) * Number(i.units_per_case) - Number(i.bottles_returned)) * Number(i.unit_deposit_fee)), 0);
    const overTotal = goods + overDeposit + Number(closedOrder.adjustment || 0);
    assert.equal(overDeposit, -25.00);
    assert.equal(overTotal, 185.00);
  });

  it('F10 — Custom price detection only flags explicit overrides and wholesaler matrix', () => {
    // POSReviewModal logic
    const posCustomPrice = (item, order, customPrices = {}) =>
      Boolean(item.is_price_overridden) ||
      (order.customer_type === 'wholesaler' && Boolean(customPrices[item.product_id]));

    // CustomerOrderDetailModal logic
    const detailModalCustomPrice = (item) => Boolean(item.is_price_overridden);

    // Case 1: Regular customer with regular price (even if catalogue base price changed later)
    const itemNormal = { product_id: 1, unit_price: 90, is_price_overridden: false };
    const regularOrder = { customer_type: 'regular' };
    assert.equal(posCustomPrice(itemNormal, regularOrder, {}), false);
    assert.equal(detailModalCustomPrice(itemNormal), false);

    // Case 2: Regular customer with overridden price
    const itemOverridden = { product_id: 1, unit_price: 85, is_price_overridden: true };
    assert.equal(posCustomPrice(itemOverridden, regularOrder, {}), true);
    assert.equal(detailModalCustomPrice(itemOverridden), true);

    // Case 3: Wholesaler with custom price in matrix
    const wholesalerOrder = { customer_type: 'wholesaler' };
    assert.equal(posCustomPrice(itemNormal, wholesalerOrder, { 1: 90 }), true);
    assert.equal(posCustomPrice(itemNormal, wholesalerOrder, {}), false);
>>>>>>> 02a8e95 (feat(v2): fix customer drawer totals (F4) and custom price badge inference (F10))
  });
});
