const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/products
router.get('/', async (req, res, next) => {
  try {
    const { include_inactive } = req.query;
    const whereClause = include_inactive === 'true' ? '' : 'WHERE is_active = TRUE';
    const { rows } = await db.query(
      `SELECT * FROM products ${whereClause} ORDER BY category NULLS LAST, name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/products
router.post('/', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const {
      name, category, unit, sku,
      base_wholesale_price = 0,
      deposit_fee = 0, current_stock = 0, units_per_case = 1,
    } = req.body;

    if (!name || !unit) {
      return res.status(400).json({ error: 'name and unit are required' });
    }

    const { rows: [product] } = await client.query(
      `INSERT INTO products
         (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, units_per_case)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, category || null, unit, sku || null,
       base_wholesale_price, deposit_fee, current_stock, units_per_case]
    );

    if (Number(current_stock) > 0) {
      await client.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by)
         VALUES ($1, 'manual_adjustment', 'current_stock', '0', $2, $3, 'Initial stock on product creation', $4)`,
        [product.id, String(current_stock), Number(current_stock), req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(product);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/products/:id — includes last 50 audit log entries
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [product] } = await db.query(
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const { rows: auditLog } = await db.query(
      `SELECT ial.*, u.full_name AS performed_by_name
       FROM inventory_audit_logs ial
       LEFT JOIN users u ON u.id = ial.performed_by
       WHERE ial.product_id = $1
       ORDER BY ial.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );

    res.json({ ...product, audit_log: auditLog });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/products/:id
router.patch('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [existing] } = await client.query(
      'SELECT * FROM products WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const {
      name, category, unit, sku, is_active,
      base_wholesale_price, deposit_fee,
      current_stock, units_per_case, reason,
    } = req.body;

    const stockChanged =
      current_stock !== undefined &&
      Number(current_stock) !== Number(existing.current_stock);

    const { rows: [product] } = await client.query(
      `UPDATE products SET
         name                 = $1,
         category             = $2,
         unit                 = $3,
         sku                  = $4,
         is_active            = $5,
         base_wholesale_price = $6,
         deposit_fee          = $7,
         current_stock        = $8,
         units_per_case       = $9,
         updated_at           = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        name                 ?? existing.name,
        category             !== undefined ? category             : existing.category,
        unit                 ?? existing.unit,
        sku                  !== undefined ? sku                  : existing.sku,
        is_active            !== undefined ? is_active            : existing.is_active,
        base_wholesale_price ?? existing.base_wholesale_price,
        deposit_fee          ?? existing.deposit_fee,
        current_stock        !== undefined ? current_stock        : existing.current_stock,
        units_per_case       !== undefined ? units_per_case       : existing.units_per_case,
        req.params.id,
      ]
    );

    // Write audit entries for mutated fields
    const auditQueue = [];

    if (stockChanged) {
      auditQueue.push({
        action_type:    'manual_adjustment',
        field_changed:  'current_stock',
        previous_value: String(existing.current_stock),
        new_value:      String(current_stock),
        delta:          Number(current_stock) - Number(existing.current_stock),
        reason:         reason || null,
      });
    }

    for (const field of ['base_wholesale_price', 'deposit_fee']) {
      const incoming = req.body[field];
      if (incoming !== undefined && Number(incoming) !== Number(existing[field])) {
        auditQueue.push({
          action_type:    'price_change',
          field_changed:  field,
          previous_value: String(existing[field]),
          new_value:      String(incoming),
          delta:          null,
          reason:         reason || null,
        });
      }
    }

    for (const entry of auditQueue) {
      await client.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [product.id, entry.action_type, entry.field_changed,
         entry.previous_value, entry.new_value, entry.delta, entry.reason, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.json(product);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
