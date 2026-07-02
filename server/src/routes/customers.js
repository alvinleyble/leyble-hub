const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity, diffFields } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/customers
router.get('/', async (req, res, next) => {
  try {
    const { include_inactive, search } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (include_inactive !== 'true') {
      conditions.push('is_active = TRUE');
    }
    if (search) {
      conditions.push(`(name ILIKE $${idx} OR phone ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT * FROM customers ${whereClause} ORDER BY name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/customers
router.post('/', async (req, res, next) => {
  try {
    const { name, customer_type = 'regular', address, phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, customer_type, address || null, phone || null, notes || null]
    );

    await logActivity(db, {
      entityType: 'customer',
      entityId:   customer.id,
      action:     'created',
      summary:    `Customer '${customer.name}' created (${customer.customer_type})`,
      performedBy: req.user.id,
    });

    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/customers/:id — includes order history
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [customer] } = await db.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { rows: orders } = await db.query(
      `SELECT
         o.id, o.status, o.total_amount, o.created_at,
         o.dispatched_at, o.delivered_at, o.closed_at,
         (SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
          FROM order_personnel op JOIN personnel per ON per.id = op.personnel_id
          WHERE op.order_id = o.id) AS personnel_summary
       FROM orders o
       WHERE o.customer_id = $1 AND o.status <> 'draft'
       ORDER BY o.created_at DESC`,
      [req.params.id]
    );

    res.json({ ...customer, orders });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/customers/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: [existing] } = await db.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const { name, customer_type, address, phone, notes, is_active, conversion_note } = req.body;

    const changes = diffFields(existing, req.body, [
      ['name', 'Name'],
      ['customer_type', 'Type'],
      ['address', 'Address'],
      ['phone', 'Phone'],
      ['notes', 'Notes'],
      ['is_active', 'Active status'],
    ]);

    // The "save custom price" flow (ADR 0001) always converts regular → wholesaler in the
    // same action as saving the customer's first custom price; carry that context into the
    // audit line so a future reader sees *why* the type changed, not just that it did.
    if (conversion_note && customer_type === 'wholesaler' && existing.customer_type !== 'wholesaler') {
      const typeChangeIdx = changes.findIndex((c) => c.startsWith('Type changed'));
      if (typeChangeIdx !== -1) {
        changes[typeChangeIdx] = `${changes[typeChangeIdx]} (${conversion_note})`;
      }
    }

    const { rows: [customer] } = await db.query(
      `UPDATE customers SET
         name          = $1,
         customer_type = $2,
         address       = $3,
         phone         = $4,
         notes         = $5,
         is_active     = $6,
         updated_at    = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        name          ?? existing.name,
        customer_type ?? existing.customer_type,
        address       !== undefined ? address    : existing.address,
        phone         !== undefined ? phone      : existing.phone,
        notes         !== undefined ? notes      : existing.notes,
        is_active     !== undefined ? is_active  : existing.is_active,
        req.params.id,
      ]
    );

    if (changes.length) {
      await logActivity(db, {
        entityType: 'customer',
        entityId:   customer.id,
        action:     'edited',
        summary:    `Customer '${customer.name}': ${changes.join('; ')}`,
        performedBy: req.user.id,
      });
    }

    res.json(customer);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/customers/:id — smart delete: permanently remove if the customer has
// never been used on an order, otherwise deactivate (orders.customer_id is RESTRICT, so a
// hard delete of a referenced customer would fail and corrupt order history / receipts).
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [existing] } = await client.query(
      'SELECT * FROM customers WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer not found' });
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*) FROM orders WHERE customer_id = $1',
      [req.params.id]
    );
    const orderCount = Number(count);

    if (orderCount > 0) {
      await client.query(
        'UPDATE customers SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
        [req.params.id]
      );
      await logActivity(client, {
        entityType: 'customer',
        entityId:   existing.id,
        action:     'deactivated',
        summary:    `Customer '${existing.name}' deactivated (has ${orderCount} order${orderCount !== 1 ? 's' : ''}; cannot be permanently deleted)`,
        performedBy: req.user.id,
      });
      await client.query('COMMIT');
      return res.json({ outcome: 'deactivated', usageCount: orderCount });
    }

    // No orders — safe to hard delete (customer_product_prices cascades on customer_id).
    await client.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
    await logActivity(client, {
      entityType: 'customer',
      entityId:   existing.id,
      action:     'deleted',
      summary:    `Customer '${existing.name}' permanently deleted`,
      performedBy: req.user.id,
    });
    await client.query('COMMIT');
    res.json({ outcome: 'deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/customers/:id/prices — most recent custom price per product, filtered by order_type
router.get('/:id/prices', async (req, res, next) => {
  try {
    const orderType = req.query.order_type || 'delivery';
    const { rows } = await db.query(
      `SELECT DISTINCT ON (cpp.product_id)
         cpp.id, cpp.product_id, cpp.customer_id, cpp.order_type,
         p.name AS product_name, p.sku, p.unit,
         cpp.custom_unit_price,
         cpp.notes, cpp.created_at,
         u.full_name AS set_by_name
       FROM customer_product_prices cpp
       JOIN  products p ON p.id = cpp.product_id
       LEFT JOIN users u ON u.id = cpp.set_by_user_id
       WHERE cpp.customer_id = $1 AND cpp.order_type = $2
       ORDER BY cpp.product_id, cpp.created_at DESC`,
      [req.params.id, orderType]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/customers/:id/prices — append a new custom price entry
router.post('/:id/prices', async (req, res, next) => {
  try {
    const { rows: [customer] } = await db.query(
      'SELECT id FROM customers WHERE id = $1',
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { product_id, custom_unit_price, notes, order_type = 'delivery' } = req.body;
    if (!product_id || custom_unit_price === undefined) {
      return res.status(400).json({ error: 'product_id and custom_unit_price are required' });
    }

    const { rows: [entry] } = await db.query(
      `INSERT INTO customer_product_prices
         (customer_id, product_id, custom_unit_price, notes, set_by_user_id, order_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, product_id, custom_unit_price,
       notes || null, req.user.id, order_type]
    );

    const { rows: [enriched] } = await db.query(
      `SELECT cpp.*, p.name AS product_name, p.sku, p.unit, u.full_name AS set_by_name
       FROM customer_product_prices cpp
       JOIN products p ON p.id = cpp.product_id
       LEFT JOIN users u ON u.id = cpp.set_by_user_id
       WHERE cpp.id = $1`,
      [entry.id]
    );

    await logActivity(db, {
      entityType: 'customer',
      entityId:   Number(req.params.id),
      action:     'price_set',
      summary:    `Custom ${order_type} price set for ${enriched.product_name}: ₱${Number(custom_unit_price).toFixed(2)}`,
      performedBy: req.user.id,
    });

    res.status(201).json(enriched);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
