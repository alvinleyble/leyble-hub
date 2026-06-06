const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/incoming
router.get('/', async (req, res, next) => {
  try {
    const { supplier_name, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (supplier_name) {
      conditions.push(`sd.supplier_name ILIKE $${idx++}`);
      params.push(`%${supplier_name}%`);
    }
    if (from_date) {
      conditions.push(`sd.received_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      conditions.push(`sd.received_at <= $${idx++}`);
      params.push(to_date);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT sd.*, u.full_name AS created_by_name,
              COUNT(sdi.id)::INT AS item_count
       FROM supplier_deliveries sd
       LEFT JOIN users u ON u.id = sd.created_by
       LEFT JOIN supplier_delivery_items sdi ON sdi.delivery_id = sd.id
       ${whereClause}
       GROUP BY sd.id, u.full_name
       ORDER BY sd.received_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/incoming — log delivery and restock products
router.post('/', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { supplier_name, notes, received_at, items } = req.body;

    if (!supplier_name) return res.status(400).json({ error: 'supplier_name is required' });
    if (!items?.length) return res.status(400).json({ error: 'At least one item is required' });

    const { rows: [delivery] } = await client.query(
      `INSERT INTO supplier_deliveries (supplier_name, notes, received_at, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [supplier_name, notes || null, received_at || new Date().toISOString(), req.user.id]
    );

    for (const item of items) {
      const { product_id, quantity_received, unit_cost, notes: itemNotes } = item;

      if (!product_id || !quantity_received) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each item requires product_id and quantity_received' });
      }

      await client.query(
        `INSERT INTO supplier_delivery_items (delivery_id, product_id, quantity_received, unit_cost, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [delivery.id, product_id, quantity_received, unit_cost || null, itemNotes || null]
      );

      const { rows: [product] } = await client.query(
        'SELECT current_stock FROM products WHERE id = $1 FOR UPDATE',
        [product_id]
      );
      const newStock = product.current_stock + quantity_received;

      await client.query(
        'UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2',
        [newStock, product_id]
      );
      await client.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by, related_delivery_id)
         VALUES ($1, 'restock', 'current_stock', $2, $3, $4, $5, $6, $7)`,
        [product_id, String(product.current_stock), String(newStock), quantity_received,
         `Supplier delivery: ${supplier_name}`, req.user.id, delivery.id]
      );
    }

    await client.query('COMMIT');

    const { rows: [fullDelivery] } = await db.query(
      `SELECT sd.*, u.full_name AS created_by_name
       FROM supplier_deliveries sd LEFT JOIN users u ON u.id = sd.created_by
       WHERE sd.id = $1`,
      [delivery.id]
    );
    const { rows: deliveryItems } = await db.query(
      `SELECT sdi.*, p.name AS product_name, p.unit
       FROM supplier_delivery_items sdi JOIN products p ON p.id = sdi.product_id
       WHERE sdi.delivery_id = $1 ORDER BY sdi.id`,
      [delivery.id]
    );

    res.status(201).json({ ...fullDelivery, items: deliveryItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/incoming/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [delivery] } = await db.query(
      `SELECT sd.*, u.full_name AS created_by_name
       FROM supplier_deliveries sd
       LEFT JOIN users u ON u.id = sd.created_by
       WHERE sd.id = $1`,
      [req.params.id]
    );
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });

    const { rows: items } = await db.query(
      `SELECT sdi.*, p.name AS product_name, p.unit
       FROM supplier_delivery_items sdi
       JOIN products p ON p.id = sdi.product_id
       WHERE sdi.delivery_id = $1
       ORDER BY sdi.id`,
      [req.params.id]
    );

    res.json({ ...delivery, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
