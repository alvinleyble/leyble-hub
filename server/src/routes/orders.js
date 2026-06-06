const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_TRANSITIONS = {
  pending:    ['in_transit', 'cancelled'],
  in_transit: ['completed', 'cancelled'],
  completed:  ['done', 'cancelled'],
};

// ─── helpers ────────────────────────────────────────────────────────────────

async function recomputeTotal(client, orderId) {
  const { rows: [{ total }] } = await client.query(
    'SELECT COALESCE(SUM(line_total), 0) AS total FROM order_items WHERE order_id = $1',
    [orderId]
  );
  await client.query(
    'UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2',
    [total, orderId]
  );
  return total;
}

async function insertItems(client, orderId, customerId, items, userId) {
  for (const item of items) {
    const { product_id, quantity, unit_price, unit_deposit_fee = 0, is_price_overridden = false } = item;

    if (!product_id || !quantity || unit_price === undefined) {
      const err = new Error('Each item requires product_id, quantity, and unit_price');
      err.status = 400;
      throw err;
    }

    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, quantity, unit_price, unit_deposit_fee, is_price_overridden)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, product_id, quantity, unit_price, unit_deposit_fee, is_price_overridden]
    );

    if (is_price_overridden) {
      await client.query(
        `INSERT INTO customer_product_prices
           (customer_id, product_id, custom_unit_price, custom_deposit_fee, set_by_user_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customerId, product_id, unit_price, unit_deposit_fee, userId,
         `Set on order #${orderId}`]
      );
    }
  }
}

async function syncPersonnel(client, orderId, personnelList) {
  await client.query('DELETE FROM order_personnel WHERE order_id = $1', [orderId]);
  for (const p of personnelList) {
    await client.query(
      `INSERT INTO order_personnel (order_id, personnel_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id, personnel_id) DO UPDATE SET role = EXCLUDED.role`,
      [orderId, p.id, p.role || 'Driver']
    );
  }
}

async function getFullOrder(orderId) {
  const { rows: [order] } = await db.query(
    `SELECT o.*,
            c.name  AS customer_name, c.customer_type,
            c.address AS customer_address, c.phone AS customer_phone
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!order) return null;

  const { rows: items } = await db.query(
    `SELECT oi.*, p.name AS product_name, p.unit, p.category
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId]
  );

  const { rows: personnel } = await db.query(
    `SELECT op.id, op.personnel_id, op.role, p.full_name, p.phone
     FROM order_personnel op
     JOIN personnel p ON p.id = op.personnel_id
     WHERE op.order_id = $1
     ORDER BY op.id`,
    [orderId]
  );

  return { ...order, items, personnel };
}

// ─── routes ─────────────────────────────────────────────────────────────────

// GET /api/v1/orders
router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status && status !== 'all') {
      conditions.push(`o.status = $${idx++}`);
      params.push(status);
    }
    if (customer_id) {
      conditions.push(`o.customer_id = $${idx++}`);
      params.push(customer_id);
    }
    if (from_date) {
      conditions.push(`o.created_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      conditions.push(`o.created_at < $${idx++}`);
      params.push(to_date);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT o.*,
              c.name AS customer_name,
              (SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
               FROM order_personnel op
               JOIN personnel per ON per.id = op.personnel_id
               WHERE op.order_id = o.id) AS personnel_summary
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders — creates a Pending order; no stock check
router.post('/', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { customer_id, notes, items, personnel = [] } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    if (!items?.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [customer] } = await client.query(
      'SELECT id FROM customers WHERE id = $1 AND is_active = TRUE',
      [customer_id]
    );
    if (!customer) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer not found' });
    }

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, notes, total_amount)
       VALUES ($1, $2, 0)
       RETURNING *`,
      [customer_id, notes || null]
    );

    await insertItems(client, order.id, customer_id, items, req.user.id);
    await recomputeTotal(client, order.id);
    await syncPersonnel(client, order.id, personnel);

    await client.query('COMMIT');
    res.status(201).json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/orders/:id
router.get('/:id', async (req, res, next) => {
  try {
    const order = await getFullOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/orders/:id — edit metadata and/or line items (pending only)
router.patch('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Only pending orders can be edited' });
    }

    const { notes, items, personnel } = req.body;

    await client.query(
      `UPDATE orders SET notes = $1, updated_at = NOW() WHERE id = $2`,
      [notes !== undefined ? notes : order.notes, order.id]
    );

    if (items !== undefined) {
      await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
      await insertItems(client, order.id, order.customer_id, items, req.user.id);
      await recomputeTotal(client, order.id);
    }

    if (personnel !== undefined) {
      await syncPersonnel(client, order.id, personnel);
    }

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/orders/:id/status — state machine transition
router.post('/:id/status', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { status: newStatus } = req.body;
    const allowed = ALLOWED_TRANSITIONS[order.status] || [];

    if (!allowed.includes(newStatus)) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error:               `Cannot transition from '${order.status}' to '${newStatus}'`,
        allowed_transitions: allowed,
      });
    }

    const { rows: items } = await client.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [req.params.id]
    );

    // ── pending → in_transit: hard stock check then debit ───────────────────
    if (newStatus === 'in_transit') {
      const needed = {};
      for (const item of items) {
        needed[item.product_id] = (needed[item.product_id] || 0) + Number(item.quantity);
      }

      const productMap = {};
      for (const productId of Object.keys(needed)) {
        const { rows: [p] } = await client.query(
          'SELECT * FROM products WHERE id = $1 FOR UPDATE',
          [productId]
        );
        productMap[productId] = p;
      }

      const shortfalls = Object.entries(needed)
        .filter(([pid, qty]) => Number(productMap[pid].current_stock) < qty)
        .map(([pid, qty]) => ({
          product_id:   Number(pid),
          product_name: productMap[pid].name,
          available:    productMap[pid].current_stock,
          required:     qty,
          shortfall:    qty - Number(productMap[pid].current_stock),
        }));

      if (shortfalls.length > 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Insufficient stock', shortfalls });
      }

      for (const [productId, qty] of Object.entries(needed)) {
        const product  = productMap[productId];
        const newStock = Number(product.current_stock) - qty;
        await client.query(
          'UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2',
          [newStock, productId]
        );
        await client.query(
          `INSERT INTO inventory_audit_logs
             (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
           VALUES ($1, 'order_fulfillment', 'current_stock', $2, $3, $4, $5, $6, $7)`,
          [productId, String(product.current_stock), String(newStock), -qty,
           `Order #${order.id} dispatched`, req.user.id, order.id]
        );
      }
    }

    // ── cancelled from in_transit/completed: restore stock ──────────────────
    if (newStatus === 'cancelled' && ['in_transit', 'completed'].includes(order.status)) {
      const needed = {};
      for (const item of items) {
        needed[item.product_id] = (needed[item.product_id] || 0) + Number(item.quantity);
      }

      for (const [productId, qty] of Object.entries(needed)) {
        const { rows: [product] } = await client.query(
          'SELECT current_stock FROM products WHERE id = $1 FOR UPDATE',
          [productId]
        );
        const newStock = Number(product.current_stock) + qty;
        await client.query(
          'UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2',
          [newStock, productId]
        );
        await client.query(
          `INSERT INTO inventory_audit_logs
             (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
           VALUES ($1, 'order_cancel', 'current_stock', $2, $3, $4, $5, $6, $7)`,
          [productId, String(product.current_stock), String(newStock), qty,
           `Order #${order.id} cancelled`, req.user.id, order.id]
        );
      }
    }

    const setClauses = ['status = $1', 'updated_at = NOW()'];
    if (newStatus === 'in_transit') setClauses.push('dispatched_at = NOW()');
    if (newStatus === 'completed')  setClauses.push('delivered_at = NOW()');
    if (['done', 'cancelled'].includes(newStatus)) setClauses.push('closed_at = NOW()');

    await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $2`,
      [newStatus, order.id]
    );

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
