const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity, diffFields } = require('../lib/activityLog');

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
      requires_bottle_return = false,
    } = req.body;

    if (!name || !unit) {
      return res.status(400).json({ error: 'name and unit are required' });
    }

    // Invariant: only returnable-bottle products carry a deposit fee.
    const depositFee = requires_bottle_return ? deposit_fee : 0;

    const { rows: [product] } = await client.query(
      `INSERT INTO products
         (name, category, unit, sku, base_wholesale_price, deposit_fee, current_stock, units_per_case, requires_bottle_return)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, category || null, unit, sku || null,
       base_wholesale_price, depositFee, current_stock, units_per_case, requires_bottle_return]
    );

    if (Number(current_stock) > 0) {
      await client.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by)
         VALUES ($1, 'manual_adjustment', 'current_stock', '0', $2, $3, 'Initial stock on product creation', $4)`,
        [product.id, String(current_stock), Number(current_stock), req.user.id]
      );
    }

    await logActivity(client, {
      entityType: 'product',
      entityId:   product.id,
      action:     'created',
      summary:    `Product '${product.name}' created (${product.category || 'no category'})`,
      performedBy: req.user.id,
    });

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
      current_stock, units_per_case, requires_bottle_return, reason,
    } = req.body;

    const stockChanged =
      current_stock !== undefined &&
      Number(current_stock) !== Number(existing.current_stock);

    // Invariant: only returnable-bottle products carry a deposit fee. Coerce against
    // the effective bottle-return flag so unchecking it also zeroes any existing deposit.
    const effectiveRBR = requires_bottle_return !== undefined
      ? requires_bottle_return : existing.requires_bottle_return;
    const depositFee = effectiveRBR ? (deposit_fee ?? existing.deposit_fee) : 0;

    // Master-data fields tracked in activity_logs (stock/price/deposit go to
    // inventory_audit_logs only — see auditQueue below — to avoid double-logging)
    const masterDataChanges = diffFields(existing, req.body, [
      ['name', 'Name'],
      ['category', 'Category'],
      ['unit', 'Unit'],
      ['sku', 'SKU'],
      ['is_active', 'Active status'],
      ['units_per_case', 'Units per case'],
      ['requires_bottle_return', 'Requires bottle return'],
    ]);

    const { rows: [product] } = await client.query(
      `UPDATE products SET
         name                  = $1,
         category              = $2,
         unit                  = $3,
         sku                   = $4,
         is_active             = $5,
         base_wholesale_price  = $6,
         deposit_fee           = $7,
         current_stock         = $8,
         units_per_case        = $9,
         requires_bottle_return = $10,
         updated_at            = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        name                  ?? existing.name,
        category              !== undefined ? category              : existing.category,
        unit                  ?? existing.unit,
        sku                   !== undefined ? sku                   : existing.sku,
        is_active             !== undefined ? is_active             : existing.is_active,
        base_wholesale_price  ?? existing.base_wholesale_price,
        depositFee,
        current_stock         !== undefined ? current_stock         : existing.current_stock,
        units_per_case        !== undefined ? units_per_case        : existing.units_per_case,
        effectiveRBR,
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

    if (base_wholesale_price !== undefined &&
        Number(base_wholesale_price) !== Number(existing.base_wholesale_price)) {
      auditQueue.push({
        action_type:    'price_change',
        field_changed:  'base_wholesale_price',
        previous_value: String(existing.base_wholesale_price),
        new_value:      String(base_wholesale_price),
        delta:          null,
        reason:         reason || null,
      });
    }

    // Audit the deposit against its coerced effective value (so unchecking bottle
    // return, which zeroes the deposit, is recorded even if deposit_fee wasn't sent).
    if (Number(depositFee) !== Number(existing.deposit_fee)) {
      auditQueue.push({
        action_type:    'price_change',
        field_changed:  'deposit_fee',
        previous_value: String(existing.deposit_fee),
        new_value:      String(depositFee),
        delta:          null,
        reason:         reason || null,
      });
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

    if (masterDataChanges.length) {
      await logActivity(client, {
        entityType: 'product',
        entityId:   product.id,
        action:     'edited',
        summary:    `Product '${product.name}': ${masterDataChanges.join('; ')}`,
        performedBy: req.user.id,
      });
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
