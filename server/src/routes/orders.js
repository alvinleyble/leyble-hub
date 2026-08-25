const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { applyDeltaMap, hasDeductedStock } = require('../lib/inventory');
const { parseReceiptNumber } = require('../lib/receiptNumbers');
const { findByReceiptNumber, isDuplicateReceiptNumber } = require('../lib/idempotency');

// Name of the partial unique index from migration 033. Used to tell a genuine
// duplicate receipt number apart from any other unique violation.
const RECEIPT_NUMBER_INDEX = 'orders_receipt_number_uniq';

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

// D1 — how an order is named to a human. The row id stays an internal detail; an order
// that carries a device-issued receipt number is referred to by it, in the activity log
// as everywhere else. Historical orders (and every order created while the V2.5 client
// switch is off) have no receipt number and keep reading as '#<id>', exactly as today.
function orderLabel(order) {
  return order?.receipt_number ? order.receipt_number : `#${order?.id}`;
}

// Resolves an order identifier (either numeric DB id or '<station>-<sequence>' receipt number)
// to the order row id.
async function resolveOrderId(runner, param) {
  if (param === undefined || param === null) return null;
  const str = String(param).trim();
  if (/^\d{1,9}-\d{1,9}$/.test(str)) {
    const [station, sequence] = str.split('-').map(Number);
    const { rows: [row] } = await runner.query(
      'SELECT id FROM orders WHERE receipt_station = $1 AND receipt_sequence = $2',
      [station, sequence]
    );
    return row ? row.id : null;
  }
  const num = Number(str);
  return Number.isInteger(num) ? num : null;
}

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

// Orders are typically entered in whatever order the customer texted them in.
// Packers work the warehouse by category, so re-sort items into category order
// (matching the ORDER BY category NULLS LAST, name convention used for the
// product list) before they're written — every downstream view (detail page,
// receipt, review queues) reads order_items back in insertion (id) order.
async function sortItemsByCategory(client, items) {
  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
  if (!productIds.length) return items;

  const { rows: products } = await client.query(
    'SELECT id, category, name FROM products WHERE id = ANY($1::int[])',
    [productIds]
  );
  const infoById = new Map(products.map((p) => [p.id, p]));

  return [...items].sort((a, b) => {
    const pa = infoById.get(a.product_id);
    const pb = infoById.get(b.product_id);
    if (!pa || !pb) return 0; // placeholder/unmatched rows (draft mid-entry): leave as-is

    if (pa.category !== pb.category) {
      if (!pa.category) return 1;
      if (!pb.category) return -1;
      return pa.category.localeCompare(pb.category);
    }
    return pa.name.localeCompare(pb.name);
  });
}

async function insertItems(client, orderId, customerId, orderType, items, userId, draft = false) {
  items = await sortItemsByCategory(client, items);
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
    // Money never goes negative on a line: a discount is the order-level
    // `adjustment` (which stays signed), never a negative price. Finalized rows
    // are rejected outright; drafts, which tolerate half-typed values, clamp.
    if (!draft && (Number(unit_price) < 0 || Number(unit_deposit_fee) < 0)) {
      const err = new Error('A price per case and a deposit fee cannot be negative.');
      err.status = 400;
      throw err;
    }
    const price   = draft ? Math.max(0, Number(unit_price) || 0) : unit_price;
    const deposit = draft ? Math.max(0, Number(unit_deposit_fee) || 0) : unit_deposit_fee;

    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, quantity, unit_price, unit_deposit_fee,
          is_price_overridden, units_per_case, bottles_returned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [orderId, product_id, qty, price, deposit, is_price_overridden, units_per_case]
    );

    if (is_price_overridden) {
      await client.query(
        `INSERT INTO customer_product_prices
           (customer_id, product_id, custom_unit_price, set_by_user_id, notes, order_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customerId, product_id, price, userId,
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
  const resolvedId = await resolveOrderId(db, orderId);
  if (!resolvedId) return null;

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
    [resolvedId]
  );
  if (!order) return null;

  const { rows: items } = await db.query(
    `SELECT oi.*, p.name AS product_name, p.sku, p.unit, p.category, p.requires_bottle_return
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [resolvedId]
  );

  const { rows: personnel } = await db.query(
    `SELECT op.id, op.personnel_id, op.role, p.full_name, p.phone
     FROM order_personnel op
     JOIN personnel p ON p.id = op.personnel_id
     WHERE op.order_id = $1
     ORDER BY op.id`,
    [resolvedId]
  );

  return { ...order, items, personnel };
}

// Deduct stock for a set of order items. Allows current_stock to go negative —
// orders are never blocked by low inventory.
async function deductStock(client, items, orderId, userId, reason) {
  const deltas = {};
  for (const item of items) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) - Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, { actionType: 'order_fulfillment', reason, userId, orderId });
}

// Restore stock for a set of order items (cancellation / revert).
async function restoreStock(client, items, orderId, userId, reason) {
  const deltas = {};
  for (const item of items) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) + Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, { actionType: 'order_cancel', reason, userId, orderId });
}

// Reconcile stock after editing an order with deducted stock.
// oldItems: DB rows before replacement. newItems: req.body items array.
// Per-product delta = oldQty − newQty (positive = restore, negative = deduct more).
async function reconcileStock(client, oldItems, newItems, order, userId) {
  const orderId = order.id;
  const deltas = {};
  for (const item of oldItems) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) + Number(item.quantity);
  }
  for (const item of newItems) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) - Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, {
    actionType: 'order_edit',
    reason: `Order ${orderLabel(order)} items edited`,
    userId,
    orderId,
  });
}

// ─── routes ─────────────────────────────────────────────────────────────────

// GET /api/v1/orders
router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id, from_date, to_date, page: pageQuery, limit: limitQuery } = req.query;
    const isPaginated = pageQuery !== undefined || limitQuery !== undefined;
    const page = Math.max(1, parseInt(pageQuery, 10) || 1);
    const limit = isPaginated
      ? Math.min(200, Math.max(1, parseInt(limitQuery, 10) || 50))
      : 200;
    const offset = (page - 1) * limit;

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
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(to_date).trim())) {
        conditions.push(`o.created_at < ($${idx++}::date + INTERVAL '1 day')`);
        params.push(String(to_date).trim());
      } else {
        conditions.push(`o.created_at < $${idx++}`);
        params.push(to_date);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitParamIdx = idx++;
    params.push(limit);
    const offsetParamIdx = idx++;
    params.push(offset);

    const { rows } = await db.query(
      `SELECT o.*,
              c.name AS customer_name,
              (SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
               FROM order_personnel op
               JOIN personnel per ON per.id = op.personnel_id
               WHERE op.order_id = o.id) AS personnel_summary,
              COUNT(*) OVER()::int AS total_count
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      params
    );

    const totalCount = rows.length > 0 ? (parseInt(rows[0].total_count, 10) || 0) : 0;
    for (const row of rows) {
      delete row.total_count;
    }

    if (isPaginated) {
      return res.json({
        orders: rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit) || 1,
        },
      });
    }

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders — creates a Pending order; no stock check
//
// Two optional fields carry the device's version of the truth when the order was
// created locally (V2.5, D1/D5/D13). Both are absent for an order created straight
// from a connected client, which behaves exactly as before:
//   receipt_number  '<station>-<sequence>' issued on the device at Save. It is the
//                   record's identity, so a resend of a number already stored is
//                   answered with the stored order and a 200 rather than a second row.
//   created_at      the device's clock at Save — the sale time printed on the paper
//                   the customer is holding, not the moment the outbox drained. Same
//                   pattern as supplier_deliveries.received_at. No clock policing.
router.post('/', async (req, res, next) => {
  const {
    customer_id, notes, items = [], personnel = [], order_type = 'delivery', status,
    receipt_number, created_at, adjustment = 0, adjustment_reason,
  } = req.body;
  const isDraft = status === 'draft';

  // Validate input before opening a connection/transaction — an early return after
  // BEGIN would release the client mid-transaction (pg won't auto-rollback).
  if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
  // A finalized order needs at least one item; a draft may be parked while still empty.
  if (!isDraft && !items?.length) return res.status(400).json({ error: 'At least one item is required' });

  let receipt = null;
  if (receipt_number !== undefined && receipt_number !== null && receipt_number !== '') {
    try {
      receipt = parseReceiptNumber(receipt_number);
    } catch (err) {
      return next(err);
    }
    // The ordinary resend: the first attempt committed and only the response was lost.
    try {
      const existingId = await findByReceiptNumber(db, 'orders', receipt);
      if (existingId) return res.json(await getFullOrder(existingId));
    } catch (err) {
      return next(err);
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [customer] } = await client.query(
      'SELECT id, name FROM customers WHERE id = $1 AND is_active = TRUE',
      [customer_id]
    );
    if (!customer) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer not found' });
    }

    const adjNum = Number(adjustment) || 0;
    const adjReason = adjNum !== 0 && adjustment_reason ? adjustment_reason.trim() : null;

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, notes, total_amount, order_type, status,
                           receipt_station, receipt_sequence, created_at, adjustment, adjustment_reason)
       VALUES ($1, $2, 0, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9)
       RETURNING *`,
      [customer_id, notes || null, order_type, isDraft ? 'draft' : 'pending',
       receipt?.station ?? null, receipt?.sequence ?? null, created_at || null,
       adjNum, adjReason]
    );

    await insertItems(client, order.id, customer_id, order_type, items, req.user.id, isDraft);
    await recomputeTotal(client, order.id);
    await syncPersonnel(client, order.id, personnel);

    // Drafts are ephemeral — the activity log entry is written when the draft is finalized.
    // Finalized pending orders deduct stock immediately at creation.
    if (!isDraft) {
      const { rows: insertedItems } = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [order.id]
      );
      await deductStock(client, insertedItems, order.id, req.user.id, `Order ${orderLabel(order)} created`);
      await logActivity(client, {
        entityType: 'order',
        entityId:   order.id,
        action:     'created',
        summary:    `Order ${orderLabel(order)} created for ${customer.name} (${order_type})`,
        performedBy: req.user.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    // Two drain attempts overlapping: both looked, neither found, both inserted. The
    // partial unique index caught this one, so answer it with the row the winner
    // wrote — a success, so the device clears it from the outbox and stops retrying.
    if (receipt && isDuplicateReceiptNumber(err, RECEIPT_NUMBER_INDEX)) {
      try {
        const existingId = await findByReceiptNumber(db, 'orders', receipt);
        if (existingId) return res.json(await getFullOrder(existingId));
      } catch (lookupErr) {
        return next(lookupErr);
      }
    }
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

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { notes, items, personnel, customer_id, order_type } = req.body;
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
      // Snapshot old items before deletion: quantity for stock reconciliation,
      // bottles_returned to preserve returns recorded when a done order was closed.
      const { rows: oldItems } = await client.query(
        'SELECT product_id, quantity, bottles_returned FROM order_items WHERE order_id = $1',
        [order.id]
      );

      await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
      await insertItems(client, order.id, order.customer_id, order.order_type, items, req.user.id, isDraft);

      // insertItems resets bottles_returned to 0. For a closed (done) order, carry
      // the previously recorded returns back per product so editing a line (e.g.
      // fixing a price) doesn't wipe returns and re-inflate the closed total. Must
      // run before recomputeTotal, which for a done order folds the deposit on
      // un-returned bottles into the total.
      if (order.status === 'done') {
        const returnsByProduct = {};
        for (const it of oldItems) {
          returnsByProduct[it.product_id] =
            (returnsByProduct[it.product_id] || 0) + Number(it.bottles_returned);
        }
        for (const [productId, returned] of Object.entries(returnsByProduct)) {
          if (returned > 0) {
            await client.query(
              `UPDATE order_items
                  SET bottles_returned = LEAST($1, FLOOR(quantity * units_per_case)),
                      updated_at = NOW()
                WHERE order_id = $2 AND product_id = $3`,
              [returned, order.id, productId]
            );
          }
        }
      }

      await recomputeTotal(client, order.id);

      changeNotes.push(`Items replaced (${items.length} item${items.length === 1 ? '' : 's'})`);

      if (!isDraft && order.status !== 'cancelled' && await hasDeductedStock(client, order.id)) {
        await reconcileStock(client, oldItems, items, order, req.user.id);
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
        summary:    `Order ${orderLabel(order)}: ${changeNotes.join('; ')}`,
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

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
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

    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [order.id]
    );
    await deductStock(client, items, order.id, req.user.id, `Order ${orderLabel(order)} finalized`);

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'created',
      summary:    `Order ${orderLabel(order)} created for ${customer?.name || 'customer'} (${order.order_type})`,
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

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
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

    const orderId = await resolveOrderId(db, req.params.id);
    if (!orderId) return res.status(404).json({ error: 'Order not found' });

    const { rows: [order] } = await db.query(
      'SELECT id, receipt_number FROM orders WHERE id = $1', [orderId]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await db.query(
      `UPDATE orders SET adjustment = $1, adjustment_reason = $2, updated_at = NOW() WHERE id = $3`,
      [adjNum, adjNum !== 0 ? adjustment_reason.trim() : null, orderId]
    );

    await logActivity(db, {
      entityType: 'order',
      entityId:   order.id,
      action:     'adjusted',
      summary:    adjNum !== 0
        ? `Order ${orderLabel(order)} adjustment set to ₱${adjNum.toFixed(2)} (reason: ${adjustment_reason.trim()})`
        : `Order ${orderLabel(order)} adjustment cleared`,
      performedBy: req.user.id,
    });

    res.json(await getFullOrder(order.id));
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

    const orderId = await resolveOrderId(db, req.params.id);
    if (!orderId) return res.status(404).json({ error: 'Order not found' });

    const { rows: [order] } = await db.query(
      'SELECT id, receipt_number FROM orders WHERE id = $1', [orderId]
    );
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
      summary:    `Order ${orderLabel(order)} receipt printed (${phase} phase)`,
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

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
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
      [order.id]
    );

    // Stock restoration on cancellation if stock was deducted for this order
    if (newStatus === 'cancelled') {
      const stockDeducted = await hasDeductedStock(client, order.id);
      if (stockDeducted) {
        await restoreStock(client, items, order.id, req.user.id, `Order ${orderLabel(order)} cancelled`);
      }
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
      summary:    `Order ${orderLabel(order)} status changed from '${order.status}' to '${newStatus}'`,
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

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
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
      summary:    `Order ${orderLabel(order)} closed; bottle returns recorded for ${items.length} item${items.length === 1 ? '' : 's'}`,
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
