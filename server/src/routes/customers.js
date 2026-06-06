const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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
    const { name, customer_type = 'wholesale', address, phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type, address, phone, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, customer_type, address || null, phone || null, notes || null]
    );
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
       WHERE o.customer_id = $1
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

    const { name, customer_type, address, phone, notes, is_active } = req.body;

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
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/customers/:id/prices — most recent custom price per product
router.get('/:id/prices', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (cpp.product_id)
         cpp.id, cpp.product_id, cpp.customer_id,
         p.name AS product_name, p.unit,
         cpp.custom_unit_price, cpp.custom_deposit_fee,
         cpp.notes, cpp.created_at,
         u.full_name AS set_by_name
       FROM customer_product_prices cpp
       JOIN  products p ON p.id = cpp.product_id
       LEFT JOIN users u ON u.id = cpp.set_by_user_id
       WHERE cpp.customer_id = $1
       ORDER BY cpp.product_id, cpp.created_at DESC`,
      [req.params.id]
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

    const { product_id, custom_unit_price, custom_deposit_fee = 0, notes } = req.body;
    if (!product_id || custom_unit_price === undefined) {
      return res.status(400).json({ error: 'product_id and custom_unit_price are required' });
    }

    const { rows: [entry] } = await db.query(
      `INSERT INTO customer_product_prices
         (customer_id, product_id, custom_unit_price, custom_deposit_fee, notes, set_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, product_id, custom_unit_price, custom_deposit_fee,
       notes || null, req.user.id]
    );

    const { rows: [enriched] } = await db.query(
      `SELECT cpp.*, p.name AS product_name, p.unit, u.full_name AS set_by_name
       FROM customer_product_prices cpp
       JOIN products p ON p.id = cpp.product_id
       LEFT JOIN users u ON u.id = cpp.set_by_user_id
       WHERE cpp.id = $1`,
      [entry.id]
    );
    res.status(201).json(enriched);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
