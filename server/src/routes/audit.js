const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/audit
// Query params: product_id, action_type, from_date, to_date, limit (max 500)
router.get('/', async (req, res, next) => {
  try {
    const { product_id, action_type, from_date, to_date, limit = 200 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (product_id) {
      conditions.push(`ial.product_id = $${idx++}`);
      params.push(product_id);
    }
    if (action_type) {
      conditions.push(`ial.action_type = $${idx++}`);
      params.push(action_type);
    }
    if (from_date) {
      conditions.push(`ial.created_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      conditions.push(`ial.created_at <= $${idx++}`);
      params.push(to_date);
    }

    const cap = Math.min(Number(limit) || 200, 500);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(cap);

    const { rows } = await db.query(
      `SELECT ial.*,
              p.name       AS product_name,
              u.full_name  AS performed_by_name
       FROM inventory_audit_logs ial
       JOIN  products p ON p.id = ial.product_id
       LEFT JOIN users u ON u.id = ial.performed_by
       ${whereClause}
       ORDER BY ial.created_at DESC
       LIMIT $${idx}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/audit/activity
// Query params: entity_type, from_date, to_date, limit (max 500)
router.get('/activity', async (req, res, next) => {
  try {
    const { entity_type, from_date, to_date, limit = 200 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (entity_type) {
      conditions.push(`al.entity_type = $${idx++}`);
      params.push(entity_type);
    }
    if (from_date) {
      conditions.push(`al.created_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      conditions.push(`al.created_at <= $${idx++}`);
      params.push(to_date);
    }

    const cap = Math.min(Number(limit) || 200, 500);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(cap);

    const { rows } = await db.query(
      `SELECT al.*,
              u.full_name AS performed_by_name
       FROM activity_logs al
       LEFT JOIN users u ON u.id = al.performed_by
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${idx}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
