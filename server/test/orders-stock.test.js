const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const { hasDeductedStock } = require('../src/lib/inventory');
const orderRoutes = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('V2 Stock Trio & Legacy Order Safety Tests', () => {
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

  describe('1. Deduct on finalize (draft -> pending)', () => {
    it('draft creation and draft edits do NOT deduct stock; finalize deducts stock and logs order_fulfillment', async () => {
      const prodA = await createProduct('TEST_PROD_DEDUCT_A', 50);
      const prodB = await createProduct('TEST_PROD_DEDUCT_B', 30);

      // Create draft order with items
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

      // Stock should be completely unchanged
      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);
      assert.equal((await getAuditLogs(draft.id)).length, 0);

      // Edit draft items
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

      // Stock still unchanged
      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);
      assert.equal((await getAuditLogs(draft.id)).length, 0);

      // Finalize draft
      const res3 = await api(`/${draft.id}/finalize`, {
        method: 'POST',
      });
      assert.equal(res3.status, 200);
      const finalized = await res3.json();
      assert.equal(finalized.status, 'pending');

      // Stock should now be deducted
      assert.equal(await getProductStock(prodA.id), 38); // 50 - 12
      assert.equal(await getProductStock(prodB.id), 22); // 30 - 8

      // Audit logs should be written
      const logs = await getAuditLogs(draft.id);
      assert.equal(logs.length, 2);
      assert.equal(logs[0].action_type, 'order_fulfillment');
      assert.equal(logs[0].product_id, prodA.id);
      assert.equal(Number(logs[0].delta), -12);
      assert.equal(logs[1].action_type, 'order_fulfillment');
      assert.equal(logs[1].product_id, prodB.id);
      assert.equal(Number(logs[1].delta), -8);
    });

    it('direct pending order creation deducts stock immediately', async () => {
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

      // Stock deducted
      assert.equal(await getProductStock(prod.id), 25); // 40 - 15

      const logs = await getAuditLogs(order.id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action_type, 'order_fulfillment');
      assert.equal(Number(logs[0].delta), -15);
    });
  });

  describe('2. Restore on cancel (pending -> cancelled)', () => {
    it('cancelling a finalized pending order restores stock and logs order_cancel', async () => {
      const prodA = await createProduct('TEST_PROD_CANCEL_A', 50);
      const prodB = await createProduct('TEST_PROD_CANCEL_B', 30);

      // Create and finalize order
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

      assert.equal(await getProductStock(prodA.id), 30);
      assert.equal(await getProductStock(prodB.id), 20);

      // Cancel order
      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);
      const cancelledOrder = await resCancel.json();
      assert.equal(cancelledOrder.status, 'cancelled');

      // Stock should be fully restored
      assert.equal(await getProductStock(prodA.id), 50);
      assert.equal(await getProductStock(prodB.id), 30);

      // Audit logs
      const logs = await getAuditLogs(order.id);
      assert.equal(logs.length, 4); // 2 fulfillment + 2 cancel
      const cancelLogs = logs.filter((l) => l.action_type === 'order_cancel');
      assert.equal(cancelLogs.length, 2);
      assert.equal(Number(cancelLogs.find((l) => l.product_id === prodA.id).delta), 20);
      assert.equal(Number(cancelLogs.find((l) => l.product_id === prodB.id).delta), 10);
    });
  });

  describe('3. Reconcile on edit (PATCH /orders/:id on pending order)', () => {
    it('editing quantities, adding, and removing items on a pending order adjusts stock by delta', async () => {
      const prodA = await createProduct('TEST_PROD_EDIT_A', 100);
      const prodB = await createProduct('TEST_PROD_EDIT_B', 100);
      const prodC = await createProduct('TEST_PROD_EDIT_C', 100);

      // Initial pending order: A=20, B=10
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

      assert.equal(await getProductStock(prodA.id), 80); // 100 - 20
      assert.equal(await getProductStock(prodB.id), 90); // 100 - 10
      assert.equal(await getProductStock(prodC.id), 100);

      // Edit: A decreased (20 -> 15), B removed (10 -> 0), C added (0 -> 25)
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

      assert.equal(await getProductStock(prodA.id), 85); // 80 + 5 (delta +5)
      assert.equal(await getProductStock(prodB.id), 100); // 90 + 10 (delta +10)
      assert.equal(await getProductStock(prodC.id), 75); // 100 - 25 (delta -25)

      const editLogs = (await getAuditLogs(order.id)).filter((l) => l.action_type === 'order_edit');
      assert.equal(editLogs.length, 3);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodA.id).delta), 5);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodB.id).delta), 10);
      assert.equal(Number(editLogs.find((l) => l.product_id === prodC.id).delta), -25);

      // Second edit: A increased (15 -> 30), C decreased (25 -> 10)
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

      assert.equal(await getProductStock(prodA.id), 70); // 85 - 15 (delta -15)
      assert.equal(await getProductStock(prodB.id), 100); // untouched
      assert.equal(await getProductStock(prodC.id), 90); // 75 + 15 (delta +15)

      // Now cancel the edited order: should restore currently active items (A: 30, C: 10)
      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);

      assert.equal(await getProductStock(prodA.id), 100); // 70 + 30
      assert.equal(await getProductStock(prodB.id), 100); // 100
      assert.equal(await getProductStock(prodC.id), 100); // 90 + 10
    });
  });

  describe('4. Critical Production Safety — Legacy Pre-Cutover Pending Orders', () => {
    it('cancelling a legacy pending order (with no fulfillment audit logs) does NOT restore stock', async () => {
      const prod = await createProduct('TEST_PROD_LEGACY_CANCEL', 100);

      // Simulate a legacy order created before cutover:
      // status = 'pending', order_items present, but ZERO rows in inventory_audit_logs
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

      // Verify initial conditions
      assert.equal(await getProductStock(prod.id), 100);
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);

      // Cancel the legacy pending order
      const res = await api(`/${legacyOrder.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(res.status, 200);
      const updated = await res.json();
      assert.equal(updated.status, 'cancelled');

      // CRITICAL: Stock must NOT have been restored to 125! It must remain exactly 100.
      assert.equal(await getProductStock(prod.id), 100);

      // CRITICAL: No fake inventory audit log entries should have been created
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);
    });

    it('editing a legacy pending order (with no fulfillment audit logs) does NOT reconcile stock', async () => {
      const prodA = await createProduct('TEST_PROD_LEGACY_EDIT_A', 100);
      const prodB = await createProduct('TEST_PROD_LEGACY_EDIT_B', 100);

      // Simulate legacy order
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

      assert.equal(await getProductStock(prodA.id), 100);
      assert.equal(await getProductStock(prodB.id), 100);
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);

      // Edit items on this legacy order (replace A:20 with A:10, B:15)
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

      // Items updated in DB
      const { rows: updatedItems } = await db.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id',
        [legacyOrder.id]
      );
      assert.equal(updatedItems.length, 2);

      // CRITICAL: Stock for prodA and prodB must remain untouched at 100
      assert.equal(await getProductStock(prodA.id), 100);
      assert.equal(await getProductStock(prodB.id), 100);

      // CRITICAL: No inventory audit logs
      assert.equal((await getAuditLogs(legacyOrder.id)).length, 0);
    });
  });

  describe('5. Inventory helper hasDeductedStock unit checks', () => {
    it('correctly identifies deducted vs non-deducted orders', async () => {
      const client = await db.connect();
      try {
        assert.equal(await hasDeductedStock(client, 99999999), false);

        // Legacy order without audit log
        const { rows: [legacy] } = await db.query(
          `INSERT INTO orders (customer_id, status, order_type, total_amount)
           VALUES ($1, 'pending', 'delivery', 100) RETURNING id`,
          [testCustomerId]
        );
        assert.equal(await hasDeductedStock(client, legacy.id), false);

        // Add audit log
        const prod = await createProduct('TEST_PROD_HELPER', 10);
        await db.query(
          `INSERT INTO inventory_audit_logs
             (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
           VALUES ($1, 'order_fulfillment', 'current_stock', '10', '8', -2, 'test', $2, $3)`,
          [prod.id, testUserId, legacy.id]
        );
        assert.equal(await hasDeductedStock(client, legacy.id), true);
      } finally {
        client.release();
      }
    });
  });

  describe('6. Edge cases and dispatch transitions', () => {
    it('dispatching (pending -> in_transit -> completed) does not double-deduct stock', async () => {
      const prod = await createProduct('TEST_PROD_DISPATCH', 50);

      // Create pending order (deducts 10 -> stock becomes 40)
      const resCreate = await api('', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: testCustomerId,
          items: [{ product_id: prod.id, quantity: 10, unit_price: 100 }],
        }),
      });
      const order = await resCreate.json();
      assert.equal(await getProductStock(prod.id), 40);

      // Transition pending -> in_transit (dispatch)
      const resDispatch = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'in_transit' }),
      });
      assert.equal(resDispatch.status, 200);
      assert.equal(await getProductStock(prod.id), 40); // Stock NOT deducted again!

      // Transition in_transit -> completed
      const resComplete = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'completed' }),
      });
      assert.equal(resComplete.status, 200);
      assert.equal(await getProductStock(prod.id), 40); // Stock NOT deducted again!

      // Step back completed -> in_transit -> pending
      const resStepBack1 = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'in_transit' }),
      });
      assert.equal(resStepBack1.status, 200);
      assert.equal(await getProductStock(prod.id), 40);

      const resStepBack2 = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'pending' }),
      });
      assert.equal(resStepBack2.status, 200);
      assert.equal(await getProductStock(prod.id), 40); // Stock NOT restored on step back

      // Finally cancel from pending
      const resCancel = await api(`/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(resCancel.status, 200);
      assert.equal(await getProductStock(prod.id), 50); // Stock restored on cancel
    });
  });
});
