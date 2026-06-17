const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

// Allowed status transitions depend on order_type for pickup orders
function getAllowedTransitions(status, orderType) {
  if (orderType === 'pickup') {
    const map = {
      pending:   ['completed', 'cancelled'],
      completed: ['pending', 'done', 'cancelled'],
      done:      ['completed'],
    };
    return map[status] || [];
  }
  const map = {
    pending:    ['in_transit', 'cancelled'],
    in_transit: ['pending', 'completed', 'cancelled'],
    completed:  ['in_transit', 'done', 'cancelled'],
    done:       ['completed'],
  };
  return map[status] || [];
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function recomputeTotal(client, orderId) {
  const { rows: [ord] } = await client.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  const { rows: [{ total }] } = await client.query(
    ord.status === 'done'
      ? 'SELECT COALESCE(SUM(line_total), 0) AS total FROM order_items WHERE order_id = $1'
      : 'SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM order_items WHERE order_id = $1',
    [orderId]
  );
  await client.query(
    'UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2',
    [total, orderId]
  );
  return total;
}

async function insertItems(client, orderId, customerId, orderType, items, userId, draft = false) {
  for (const item of items) {
    const {
      product_id, quantity, unit_price,
      unit_deposit_fee = 0, is_price_overridden = false,
      units_per_case = 1,
    } = item;

    if (draft) {
      // Drafts can be incomplete: skip placeholder rows with no product selected yet.
      if (!product_id) continue;
    } else if (!product_id || !quantity || unit_price === undefined) {
      const err = new Error('Each item requires product_id, quantity, and unit_price');
      err.status = 400;
      throw err;
    }

    // Drafts tolerate a blank quantity/price (e.g. mid-entry). quantity has a
    // CHECK (> 0), so fall back to 1; unit_price may be 0.
    const qty   = draft ? (Number(quantity) > 0 ? Number(quantity) : 1) : quantity;
    const price = draft ? (Number(unit_price) || 0) : unit_price;

    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, quantity, unit_price, unit_deposit_fee,
          is_price_overridden, units_per_case, bottles_returned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [orderId, product_id, qty, price, unit_deposit_fee, is_price_overridden, units_per_case]
    );

    if (is_price_overridden) {
      await client.query(
        `INSERT INTO customer_product_prices
           (customer_id, product_id, custom_unit_price, set_by_user_id, notes, order_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customerId, product_id, unit_price, userId,
         `Set on order #${orderId}`, orderType || 'delivery']
      );
    }
  }
}

async function syncPersonnel(client, orderId, personnelList) {
  // Business rule: at most one Driver per order (role defaults to 'Driver' below,
  // so the default must be applied when counting).
  const driverCount = personnelList.filter((p) => (p.role || 'Driver') === 'Driver').length;
  if (driverCount > 1) {
    const err = new Error('Only one personnel can be assigned as Driver per order.');
    err.status = 400;
    throw err;
  }

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
            c.address AS customer_address, c.phone AS customer_phone,
            up.full_name AS pending_receipt_printed_by_name,
            ud.full_name AS delivered_receipt_printed_by_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users up ON up.id = o.pending_receipt_printed_by
     LEFT JOIN users ud ON ud.id = o.delivered_receipt_printed_by
     WHERE o.id = $1`,
    [orderId]
  );
  if (!order) return null;

  const { rows: items } = await db.query(
    `SELECT oi.*, p.name AS product_name, p.sku, p.unit, p.category, p.requires_bottle_return
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

// Deduct stock for a set of order items. Allows current_stock to go negative —
// orders are never blocked by low inventory.
async function deductStock(client, items, orderId, userId, reason) {
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
      [productId, String(product.current_stock), String(newStock), -qty, reason, userId, orderId]
    );
  }
}

// Restore stock for a set of order items (cancellation).
async function restoreStock(client, items, orderId, userId, reason) {
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
      [productId, String(product.current_stock), String(newStock), qty, reason, userId, orderId]
    );
  }
}

// Reconcile stock after editing a dispatched order (in_transit/completed/done).
// oldItems: DB rows before replacement. newItems: req.body items array.
async function reconcileStock(client, oldItems, newItems, orderId, userId) {
  const oldMap = {};
  for (const item of oldItems) {
    oldMap[item.product_id] = (oldMap[item.product_id] || 0) + Number(item.quantity);
  }
  const newMap = {};
  for (const item of newItems) {
    newMap[item.product_id] = (newMap[item.product_id] || 0) + Number(item.quantity);
  }

  const allIds = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap).map(String)])];

  for (const productId of allIds) {
    const oldQty = oldMap[productId] || 0;
    const newQty = newMap[productId] || 0;
    const delta  = oldQty - newQty; // positive = restore, negative = deduct more
    if (delta === 0) continue;

    const { rows: [product] } = await client.query(
      'SELECT current_stock FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    const newStock = Number(product.current_stock) + delta;
    await client.query(
      'UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2',
      [newStock, productId]
    );
    await client.query(
      `INSERT INTO inventory_audit_logs
         (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_order_id)
       VALUES ($1, 'manual_adjustment', 'current_stock', $2, $3, $4, $5, $6, $7)`,
      [productId, String(product.current_stock), String(newStock), delta,
       `Order #${orderId} edited after dispatch`, userId, orderId]
    );
  }
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
    } else {
      // Drafts only appear under the dedicated Drafts tab (status=draft), never in
      // the All view or any other tab.
      conditions.push(`o.status <> 'draft'`);
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

    const { customer_id, notes, items = [], personnel = [], order_type = 'delivery', status } = req.body;
    const isDraft = status === 'draft';

    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    // A finalized order needs at least one item; a draft may be parked while still empty.
    if (!isDraft && !items?.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [customer] } = await client.query(
      'SELECT id, name FROM customers WHERE id = $1 AND is_active = TRUE',
      [customer_id]
    );
    if (!customer) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer not found' });
    }

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, notes, total_amount, order_type, status)
       VALUES ($1, $2, 0, $3, $4)
       RETURNING *`,
      [customer_id, notes || null, order_type, isDraft ? 'draft' : 'pending']
    );

    await insertItems(client, order.id, customer_id, order_type, items, req.user.id, isDraft);
    await recomputeTotal(client, order.id);
    await syncPersonnel(client, order.id, personnel);

    // Drafts are ephemeral — the activity log entry is written when the draft is finalized.
    if (!isDraft) {
      await logActivity(client, {
        entityType: 'order',
        entityId:   order.id,
        action:     'created',
        summary:    `Order #${order.id} created for ${customer.name} (${order_type})`,
        performedBy: req.user.id,
      });
    }

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

// PATCH /api/v1/orders/:id — edit metadata and/or line items (all statuses)
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

    const { notes, items, personnel, customer_id, order_type } = req.body;
    const DISPATCHED_STATUSES = ['in_transit', 'completed', 'done'];
    const isDraft = order.status === 'draft';

    const changeNotes = [];

    if (notes !== undefined && notes !== order.notes) changeNotes.push('Notes updated');

    await client.query(
      `UPDATE orders SET notes = $1, updated_at = NOW() WHERE id = $2`,
      [notes !== undefined ? notes : order.notes, order.id]
    );

    // A parked draft may still change its customer / order type (COALESCE keeps the
    // current value when a field is omitted). Live orders never change these here.
    if (isDraft && (customer_id !== undefined || order_type !== undefined)) {
      await client.query(
        `UPDATE orders SET customer_id = COALESCE($1, customer_id),
                           order_type  = COALESCE($2, order_type),
                           updated_at  = NOW()
         WHERE id = $3`,
        [customer_id ?? null, order_type ?? null, order.id]
      );
    }

    if (items !== undefined) {
      // Snapshot old items before deletion for stock reconciliation
      const { rows: oldItems } = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [order.id]
      );

      await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
      await insertItems(client, order.id, order.customer_id, order.order_type, items, req.user.id, isDraft);
      await recomputeTotal(client, order.id);

      changeNotes.push(`Items replaced (${items.length} item${items.length === 1 ? '' : 's'})`);

      if (DISPATCHED_STATUSES.includes(order.status)) {
        await reconcileStock(client, oldItems, items, order.id, req.user.id);
      }
    }

    if (personnel !== undefined) {
      await syncPersonnel(client, order.id, personnel);
      changeNotes.push('Personnel updated');
    }

    // Draft auto-saves are silent; the activity log records the order at finalize time.
    if (changeNotes.length && !isDraft) {
      await logActivity(client, {
        entityType: 'order',
        entityId:   order.id,
        action:     'edited',
        summary:    `Order #${order.id}: ${changeNotes.join('; ')}`,
        performedBy: req.user.id,
      });
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

// POST /api/v1/orders/:id/finalize — turn a draft into a real Pending order
router.post('/:id/finalize', async (req, res, next) => {
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
    if (order.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft orders can be finalized' });
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::INT AS count FROM order_items WHERE order_id = $1',
      [order.id]
    );
    if (count === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Add at least one product before creating the order' });
    }

    const { rows: [customer] } = await client.query(
      'SELECT name FROM customers WHERE id = $1',
      [order.customer_id]
    );

    await client.query(
      `UPDATE orders SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );
    await recomputeTotal(client, order.id);

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'created',
      summary:    `Order #${order.id} created for ${customer?.name || 'customer'} (${order.order_type})`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/v1/orders/:id — only drafts may be deleted (real orders are cancelled, not removed)
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft orders can be deleted' });
    }

    await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM order_personnel WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM orders WHERE id = $1', [order.id]);

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/orders/:id/adjustment — set billing adjustment and reason
router.patch('/:id/adjustment', async (req, res, next) => {
  try {
    const { adjustment, adjustment_reason } = req.body;
    const adjNum = Number(adjustment);

    if (isNaN(adjNum)) {
      return res.status(400).json({ error: 'adjustment must be a number' });
    }
    if (adjNum !== 0 && !adjustment_reason?.trim()) {
      return res.status(400).json({ error: 'adjustment_reason is required when adjustment is non-zero' });
    }

    const { rows: [order] } = await db.query('SELECT id FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await db.query(
      `UPDATE orders SET adjustment = $1, adjustment_reason = $2, updated_at = NOW() WHERE id = $3`,
      [adjNum, adjNum !== 0 ? adjustment_reason.trim() : null, req.params.id]
    );

    await logActivity(db, {
      entityType: 'order',
      entityId:   order.id,
      action:     'adjusted',
      summary:    adjNum !== 0
        ? `Order #${order.id} adjustment set to ₱${adjNum.toFixed(2)} (reason: ${adjustment_reason.trim()})`
        : `Order #${order.id} adjustment cleared`,
      performedBy: req.user.id,
    });

    res.json(await getFullOrder(req.params.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders/:id/receipt-printed — tag that a receipt was printed and
// confirmed by the user, for either the 'pending' or 'delivered' phase
router.post('/:id/receipt-printed', async (req, res, next) => {
  try {
    const { phase } = req.body;
    if (!['pending', 'delivered'].includes(phase)) {
      return res.status(400).json({ error: "phase must be 'pending' or 'delivered'" });
    }

    const { rows: [order] } = await db.query('SELECT id FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const column = phase === 'pending' ? 'pending_receipt_printed' : 'delivered_receipt_printed';
    await db.query(
      `UPDATE orders SET ${column}_at = NOW(), ${column}_by = $1, updated_at = NOW() WHERE id = $2`,
      [req.user.id, order.id]
    );

    await logActivity(db, {
      entityType: 'order',
      entityId:   order.id,
      action:     'receipt_printed',
      summary:    `Order #${order.id} receipt printed (${phase} phase)`,
      performedBy: req.user.id,
    });

    res.json(await getFullOrder(order.id));
  } catch (err) {
    next(err);
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
    const allowed = getAllowedTransitions(order.status, order.order_type);

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

    // Stock deduction: delivery uses in_transit, pickup uses completed
    const isDeductTransition =
      (order.order_type === 'delivery' && newStatus === 'in_transit') ||
      (order.order_type === 'pickup'   && newStatus === 'completed' && order.status === 'pending');

    if (isDeductTransition) {
      await deductStock(client, items, order.id, req.user.id, `Order #${order.id} ${order.order_type === 'pickup' ? 'picked up' : 'dispatched'}`);
    }

    // Stock restoration on cancellation, or on stepping back across the deduction boundary
    if ((newStatus === 'cancelled' || newStatus === 'pending') &&
        ['in_transit', 'completed'].includes(order.status)) {
      await restoreStock(client, items, order.id, req.user.id,
        newStatus === 'cancelled'
          ? `Order #${order.id} cancelled`
          : `Order #${order.id} status reverted to pending`);
    }

    const STEP_BACK = new Set([
      'in_transit→pending',
      'completed→in_transit',
      'completed→pending',
      'done→completed',
    ]);
    const isStepBack = STEP_BACK.has(`${order.status}→${newStatus}`);

    const setClauses = ['status = $1', 'updated_at = NOW()'];
    if (newStatus === 'in_transit') setClauses.push('dispatched_at = NOW()');
    if (newStatus === 'completed')  setClauses.push('delivered_at = NOW()');
    if (['done', 'cancelled'].includes(newStatus)) setClauses.push('closed_at = NOW()');
    if (isStepBack) {
      if (order.status === 'in_transit') setClauses.push('dispatched_at = NULL');
      if (order.status === 'completed') {
        setClauses.push('delivered_at = NULL', 'delivered_receipt_printed_at = NULL', 'delivered_receipt_printed_by = NULL');
      }
      if (order.status === 'done')       setClauses.push('closed_at = NULL');
    }

    await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $2`,
      [newStatus, order.id]
    );

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'status_changed',
      summary:    `Order #${order.id} status changed from '${order.status}' to '${newStatus}'`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/orders/:id/close — record bottle returns then transition completed → done
router.post('/:id/close', async (req, res, next) => {
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
    if (order.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Only completed orders can be closed' });
    }

    const { items = [] } = req.body;
    for (const { id, bottles_returned } of items) {
      await client.query(
        `UPDATE order_items
            SET bottles_returned = $1, updated_at = NOW()
          WHERE id = $2 AND order_id = $3`,
        [Number(bottles_returned) || 0, id, order.id]
      );
    }

    await client.query(
      `UPDATE orders SET status = 'done', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [order.id]
    );

    await recomputeTotal(client, order.id);

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'closed',
      summary:    `Order #${order.id} closed; bottle returns recorded for ${items.length} item${items.length === 1 ? '' : 's'}`,
      performedBy: req.user.id,
    });

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
