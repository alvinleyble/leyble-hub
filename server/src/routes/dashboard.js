const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/dashboard
router.get('/', async (req, res, next) => {
  try {
    // Rolling 5-day window UNION all open orders (regardless of age)
    const { rows: orders } = await db.query(
      `SELECT o.*,
              c.name    AS customer_name,
              c.address AS customer_address,
              uc.full_name AS sold_by_name,
              (SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
               FROM order_personnel op JOIN personnel per ON per.id = op.personnel_id
               WHERE op.order_id = o.id) AS personnel_summary
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users uc ON uc.id = o.created_by
       WHERE o.status IN ('pending', 'in_transit', 'completed')
          OR o.created_at >= NOW() - INTERVAL '5 days'
       ORDER BY
         CASE o.status
           WHEN 'in_transit' THEN 1
           WHEN 'pending'    THEN 2
           WHEN 'completed'  THEN 3
           ELSE 4
         END,
         o.created_at ASC`
    );

    // Status summary counts (open orders only)
    const { rows: [counts] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')    AS pending_count,
         COUNT(*) FILTER (WHERE status = 'in_transit') AS in_transit_count,
         COUNT(*) FILTER (WHERE status = 'completed')  AS completed_count
       FROM orders
       WHERE status IN ('pending', 'in_transit', 'completed')`
    );

    // Low stock warning (≤ 10 units)
    const { rows: lowStock } = await db.query(
      `SELECT id, name, category, unit, current_stock
       FROM products
       WHERE current_stock <= 10 AND is_active = TRUE
       ORDER BY current_stock ASC`
    );

    // Open ticket count
    const { rows: [{ pending_tickets }] } = await db.query(
      `SELECT COUNT(*)::INT AS pending_tickets FROM tickets WHERE status = 'pending'`
    );

    res.json({
      orders,
      summary: {
        pending_count:    Number(counts.pending_count),
        in_transit_count: Number(counts.in_transit_count),
        completed_count:  Number(counts.completed_count),
        pending_tickets,
      },
      low_stock: lowStock,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
