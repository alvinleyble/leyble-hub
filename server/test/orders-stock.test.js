const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const { isStockOut } = require('../src/lib/inventory');
const orderRoutes = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

// ADR 0012 — stock deducts at DISPATCH, not at save.
//
// This suite used to pin V2's deduct-on-save behaviour; those assertions are inverted here
// rather than deleted, so the two models stay legible side by side. What is asserted now:
// save/finalize move nothing, the dispatch transition moves stock (in_transit for
// deliveries, completed for pickups), stepping back behind that boundary puts it back, and
// the two populations of pre-existing rows — never-deducted (pre-V2) and already-deducted
// (V2 window) — are each handled without a double move.
describe('Stock deducts at dispatch (ADR 0012)', () => {
  let server;
  let baseUrl;
  let authToken;
  let testUserId;
  let testCustomerId;

  before(async () => {
    // Use or get admin user
    let { rows: [user] } = await db.query(
      `SELECT id, email, full_name, role FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (!user) {
      const { rows: [created] } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('test-stock@leyblestore.com', 'dummyhash', 'Stock Tester', 'admin')
         RETURNING id, email, full_name, role`
      );
      user = created;
    }
    testUserId = user.id;

    authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET
    );

    // Setup test customer
    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone)
       VALUES ('Test Customer Stock', 'regular', '123 Test St', '09123456789')
       RETURNING id`
    );
    testCustomerId = customer.id;

    // Express app setup
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Clean up test data respecting foreign key constraints
    await db.query(`
      DELETE FROM inventory_audit_logs
      WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'TEST_PROD_%')
         OR (related_order_id IS NOT NULL AND related_order_id IN (SELECT id FROM orders WHERE customer_id = $1))
    `, [testCustomerId]);

    if (testCustomerId) {
      await db.query(`
        DELETE FROM order_items
        WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'TEST_PROD_%')
           OR order_id IN (SELECT id FROM orders WHERE customer_id = $1)
      `, [testCustomerId]);
      await db.query('DELETE FROM order_personnel WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [testCustomerId]);
      await db.query('DELETE FROM activity_logs WHERE entity_id IN (SELECT id FROM orders WHERE customer_id = $1) AND entity_type = \'order\'', [testCustomerId]);
      await db.query('DELETE FROM orders WHERE customer_id = $1', [testCustomerId]);
      await db.query('DELETE FROM customers WHERE id = $1', [testCustomerId]);
    }
    await db.query("DELETE FROM products WHERE name LIKE 'TEST_PROD_%'");
  });

  async function createProduct(name, initialStock, price = 100) {
    const sku = `SKU_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const { rows: [product] } = await db.query(
      `INSERT INTO products (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, is_active)
       VALUES ($1, 'Beer', 'case', $2, $3, 0, $4, TRUE)
       RETURNING *`,
      [name, sku, price, initialStock]
    );
    return product;
  }

  async function getProductStock(productId) {
    const { rows: [product] } = await db.query(
      'SELECT current_stock FROM products WHERE id = $1',
      [productId]
    );
    return Number(product.current_stock);
  }

  async function getAuditLogs(orderId) {
    const { rows } = await db.query(
      'SELECT * FROM inventory_audit_logs WHERE related_order_id = $1 ORDER BY id ASC',
      [orderId]
    );
    return rows;
  }

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

  describe('1. Save and finalize move no stock', () => {
    it('draft create, draft edit and finalize all leave stock untouched', async () => {
      const prodA = await createProduct('TEST_PROD_DEDUCT_A', 50);
      const prodB = await createProduct('TEST_PROD_DEDUCT_B', 30);

      const res1 = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          status: 'draft',
          items: [
            { product_id: prodA.id, quantity: 10, unit_price: 100 },
            { product_id: prodB.id, quantity: 5, unit_price: 150 },
          ],
        }),
      });
      assert.equal(res1.status, 201);
      const draft = await res1.json();
      assert.equal(draft.status, 'draft');

      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);
      assert.equal((await getAuditLogs(draft.id)).length, 0);

      const res2 = await api(`/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: prodA.id, quantity: 12, unit_price: 100 },
            { product_id: prodB.id, quantity: 8, unit_price: 150 },
          ],
        }),
      });
      assert.equal(res2.status, 200);

      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);
      assert.equal((await getAuditLogs(draft.id)).length, 0);

      const res3 = await api(`/${draft.id}/finalize`, { method: 'POST' });
      assert.equal(res3.status, 200);
      const finalized = await res3.json();
      assert.equal(finalized.status, 'pending');

      // ADR 0012: finalizing creates the order; it does not move the goods.
      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);
      assert.equal((await getAuditLogs(draft.id)).length, 0);
    });

    it('direct pending order creation leaves stock untouched', async () => {
      const prod = await createProduct('TEST_PROD_DIRECT_CREATE', 40);

      const res = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prod.id, quantity: 15, unit_price: 100 }],
        }),
      });
      assert.equal(res.status, 201);
      const order = await res.json();
      assert.equal(order.status, 'pending');

      assert.equal(await getProductStock(prod.id), 40);
      assert.equal((await getAuditLogs(order.id)).length, 0);
    });
  });

  describe('2. Dispatch deducts', () => {
    it('a delivery deducts on pending -> in_transit and logs order_fulfillment', async () => {
      const prodA = await createProduct('TEST_PROD_DISPATCH_A', 50);
      const prodB = await createProduct('TEST_PROD_DISPATCH_B', 30);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          order_type: 'delivery',
          items: [
            { product_id: prodA.id, quantity: 12, unit_price: 100 },
            { product_id: prodB.id, quantity: 8, unit_price: 150 },
          ],
        }),
      });
      const order = await resCreate.json();
      assert.equal(await getProductStock(prodA.id), 50);

      const resDispatch = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'in_transit' }),
      });
      assert.equal(resDispatch.status, 200);

      assert.equal(await getProductStock(prodA.id), 38); // 50 - 12
      assert.equal(await getProductStock(prodB.id), 22); // 30 - 8

      const logs = await getAuditLogs(order.id);
      assert.equal(logs.length, 2);
      assert.ok(logs.every((l) => l.action_type === 'order_fulfillment'));
      assert.equal(Number(logs.find((l) => l.product_id === prodA.id).delta), -12);
      assert.equal(Number(logs.find((l) => l.product_id === prodB.id).delta), -8);

      // Advancing further must not move stock a second time.
      await api(`/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
      assert.equal(await getProductStock(prodA.id), 38);
      assert.equal((await getAuditLogs(order.id)).length, 2);
    });

    it('a pickup deducts on pending -> completed, not before', async () => {
      const prod = await createProduct('TEST_PROD_PICKUP', 60);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          order_type: 'pickup',
          items: [{ product_id: prod.id, quantity: 20, unit_price: 100 }],
        }),
      });
      const order = await resCreate.json();
      assert.equal(order.order_type, 'pickup');
      assert.equal(await getProductStock(prod.id), 60);

      const res = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'completed' }),
      });
      assert.equal(res.status, 200);
      assert.equal(await getProductStock(prod.id), 40); // 60 - 20

      const logs = await getAuditLogs(order.id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action_type, 'order_fulfillment');
      assert.equal(Number(logs[0].delta), -20);
    });
  });

  describe('3. Crossing the boundary back and forth', () => {
    it('step back to pending restores, re-dispatch deducts again, cancel restores', async () => {
      const prod = await createProduct('TEST_PROD_BOUNDARY', 50);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prod.id, quantity: 10, unit_price: 100 }],
        }),
      });
      const order = await resCreate.json();
      assert.equal(await getProductStock(prod.id), 50);

      await api(`/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) });
      assert.equal(await getProductStock(prod.id), 40);

      // Back behind the deduction boundary — the goods are in the warehouse again.
      const resBack = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'pending' }),
      });
      assert.equal(resBack.status, 200);
      assert.equal(await getProductStock(prod.id), 50);

      // And out again. "Ever deducted" would have made this a no-op; "currently out" does not.
      await api(`/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) });
      assert.equal(await getProductStock(prod.id), 40);

      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);
      assert.equal(await getProductStock(prod.id), 50);
    });

    it('cancelling a pending order restores nothing, because nothing left', async () => {
      const prod = await createProduct('TEST_PROD_CANCEL_PENDING', 50);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prod.id, quantity: 20, unit_price: 100 }],
        }),
      });
      const order = await resCreate.json();

      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);

      assert.equal(await getProductStock(prod.id), 50);
      assert.equal((await getAuditLogs(order.id)).length, 0);
    });
  });

  describe('4. Reconcile on edit follows the goods, not the status name', () => {
    it('editing a pending (un-dispatched) order moves no stock', async () => {
      const prodA = await createProduct('TEST_PROD_EDIT_PENDING_A', 100);
      const prodB = await createProduct('TEST_PROD_EDIT_PENDING_B', 100);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prodA.id, quantity: 20, unit_price: 100 }],
        }),
      });
      const order = await resCreate.json();

      const res = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: prodA.id, quantity: 5, unit_price: 100 },
            { product_id: prodB.id, quantity: 40, unit_price: 100 },
          ],
        }),
      });
      assert.equal(res.status, 200);

      assert.equal(await getProductStock(prodA.id), 100);
      assert.equal(await getProductStock(prodB.id), 100);
      assert.equal((await getAuditLogs(order.id)).length, 0);
    });

    it('editing a dispatched order adjusts stock by the per-product delta', async () => {
      const prodA = await createProduct('TEST_PROD_EDIT_A', 100);
      const prodB = await createProduct('TEST_PROD_EDIT_B', 100);
      const prodC = await createProduct('TEST_PROD_EDIT_C', 100);

      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [
            { product_id: prodA.id, quantity: 20, unit_price: 100 },
            { product_id: prodB.id, quantity: 10, unit_price: 100 },
          ],
        }),
      });
      const order = await resCreate.json();

      await api(`/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'in_transit' }) });
      assert.equal(await getProductStock(prodA.id), 80);
      assert.equal(await getProductStock(prodB.id), 90);
      assert.equal(await getProductStock(prodC.id), 100);

      // A decreased (20 -> 15), B removed (10 -> 0), C added (0 -> 25)
      const resEdit1 = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: prodA.id, quantity: 15, unit_price: 100 },
            { product_id: prodC.id, quantity: 25, unit_price: 100 },
          ],
        }),
      });
      assert.equal(resEdit1.status, 200);

      assert.equal(await getProductStock(prodA.id), 85);  // 80 + 5
      assert.equal(await getProductStock(prodB.id), 100); // 90 + 10
      assert.equal(await getProductStock(prodC.id), 75);  // 100 - 25

      const editLogs = (await getAuditLogs(order.id)).filter((l) => l.action_type === 'order_edit');
      assert.equal(editLogs.length, 3);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodA.id).delta), 5);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodB.id).delta), 10);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodC.id).delta), -25);

      // A increased (15 -> 30), C decreased (25 -> 10)
      const resEdit2 = await api(`/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: prodA.id, quantity: 30, unit_price: 100 },
            { product_id: prodC.id, quantity: 10, unit_price: 100 },
          ],
        }),
      });
      assert.equal(resEdit2.status, 200);

      assert.equal(await getProductStock(prodA.id), 70);  // 85 - 15
      assert.equal(await getProductStock(prodB.id), 100);
      assert.equal(await getProductStock(prodC.id), 90);  // 75 + 15

      // Cancelling restores whatever is currently on the order (A: 30, C: 10).
      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);

      assert.equal(await getProductStock(prodA.id), 100);
      assert.equal(await getProductStock(prodB.id), 100);
      assert.equal(await getProductStock(prodC.id), 100);
    });
  });

  describe('5. Pre-existing rows: never-deducted and already-deducted', () => {
    it('cancelling a pre-V2 pending order (no audit logs) does NOT restore stock', async () => {
      const prod = await createProduct('TEST_PROD_LEGACY_CANCEL', 100);

      const { rows: [legacyOrder] } = await db.query(
        `INSERT INTO orders (customer_id, status, order_type, total_amount, created_at, updated_at)
         VALUES ($1, 'pending', 'delivery', 500, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
         RETURNING *`,
        [testCustomerId]
      );
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, units_per_case, bottles_returned)
         VALUES ($1, $2, 25, 20, 0, 1, 0)`,
        [legacyOrder.id, prod.id]
      );

      assert.equal(await getProductStock(prod.id), 100);
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);

      const res = await api(`/${legacyOrder.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(res.status, 200);

      // Must NOT become 125 — that stock never left.
      assert.equal(await getProductStock(prod.id), 100);
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);
    });

    it('editing a pre-V2 pending order (no audit logs) does NOT reconcile stock', async () => {
      const prodA = await createProduct('TEST_PROD_LEGACY_EDIT_A', 100);
      const prodB = await createProduct('TEST_PROD_LEGACY_EDIT_B', 100);

      const { rows: [legacyOrder] } = await db.query(
        `INSERT INTO orders (customer_id, status, order_type, total_amount, created_at, updated_at)
         VALUES ($1, 'pending', 'delivery', 500, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
         RETURNING *`,
        [testCustomerId]
      );
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, units_per_case, bottles_returned)
         VALUES ($1, $2, 20, 25, 0, 1, 0)`,
        [legacyOrder.id, prodA.id]
      );

      const res = await api(`/${legacyOrder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          items: [
            { product_id: prodA.id, quantity: 10, unit_price: 25 },
            { product_id: prodB.id, quantity: 15, unit_price: 20 },
          ],
        }),
      });
      assert.equal(res.status, 200);

      const { rows: updatedItems } = await db.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id',
        [legacyOrder.id]
      );
      assert.equal(updatedItems.length, 2);

      assert.equal(await getProductStock(prodA.id), 100);
      assert.equal(await getProductStock(prodB.id), 100);
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);
    });

    it('a V2-window pending order (already deducted at save) is not deducted again on dispatch', async () => {
      const prod = await createProduct('TEST_PROD_V2_WINDOW', 100);

      // Exactly what V2 left behind: pending, stock already out, one order_fulfillment row.
      const { rows: [order] } = await db.query(
        `INSERT INTO orders (customer_id, status, order_type, total_amount)
         VALUES ($1, 'pending', 'delivery', 500) RETURNING *`,
        [testCustomerId]
      );
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee, units_per_case, bottles_returned)
         VALUES ($1, $2, 30, 20, 0, 1, 0)`,
        [order.id, prod.id]
      );
      await db.query('UPDATE products SET current_stock = 70 WHERE id = $1', [prod.id]);
      await db.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
         VALUES ($1, 'order_fulfillment', 'current_stock', '100', '70', -30, 'V2-window save', $2, $3)`,
        [prod.id, testUserId, order.id]
      );

      const resDispatch = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'in_transit' }),
      });
      assert.equal(resDispatch.status, 200);
      assert.equal(await getProductStock(prod.id), 70); // NOT 40
      assert.equal((await getAuditLogs(order.id)).length, 1);

      // And it still restores correctly when cancelled.
      await api(`/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
      assert.equal(await getProductStock(prod.id), 100);
    });
  });

  describe('6. isStockOut unit checks', () => {
    it('reads an order\'s net stock movement, not whether it ever moved', async () => {
      const client = await db.connect();
      try {
        assert.equal(await isStockOut(client, 99999999), false);

        const { rows: [order] } = await db.query(
          `INSERT INTO orders (customer_id, status, order_type, total_amount)
           VALUES ($1, 'pending', 'delivery', 100) RETURNING id`,
          [testCustomerId]
        );
        assert.equal(await isStockOut(client, order.id), false);

        const prod = await createProduct('TEST_PROD_HELPER', 10);
        await db.query(
          `INSERT INTO inventory_audit_logs
             (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
           VALUES ($1, 'order_fulfillment', 'current_stock', '10', '8', -2, 'test', $2, $3)`,
          [prod.id, testUserId, order.id]
        );
        assert.equal(await isStockOut(client, order.id), true);

        // Restored — net zero, so no longer out. This is the case hasDeductedStock got wrong.
        await db.query(
          `INSERT INTO inventory_audit_logs
             (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
           VALUES ($1, 'order_cancel', 'current_stock', '8', '10', 2, 'test', $2, $3)`,
          [prod.id, testUserId, order.id]
        );
        assert.equal(await isStockOut(client, order.id), false);
      } finally {
        client.release();
      }
    });
  });

  describe('7. Draft deletion (DELETE /orders/:id)', () => {
    it('successfully deletes a draft order and leaves stock untouched', async () => {
      const prod = await createProduct('TEST_PROD_DRAFT_DEL', 50);

      // Create draft
      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          status: 'draft',
          items: [{ product_id: prod.id, quantity: 10, unit_price: 100 }],
        }),
      });
      assert.equal(resCreate.status, 201);
      const draft = await resCreate.json();
      assert.equal(draft.status, 'draft');

      // Delete draft
      const resDel = await api(`/${draft.id}`, { method: 'DELETE' });
      assert.equal(resDel.status, 204);

      // Verify draft no longer exists
      const resGet = await api(`/${draft.id}`);
      assert.equal(resGet.status, 404);

      // Verify stock is untouched
      assert.equal(await getProductStock(prod.id), 50);
    });

    it('rejects deletion of non-draft orders with 400', async () => {
      const prod = await createProduct('TEST_PROD_PENDING_DEL', 50);

      // Create pending order
      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prod.id, quantity: 5, unit_price: 100 }],
        }),
      });
      assert.equal(resCreate.status, 201);
      const order = await resCreate.json();
      assert.equal(order.status, 'pending');

      // Attempt to delete pending order
      const resDel = await api(`/${order.id}`, { method: 'DELETE' });
      assert.equal(resDel.status, 400);

      // Clean up order via cancellation
      await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
    });
  });
});
