const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeSalesDashboard } = require('../lib/salesDashboard');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/dashboard — sales and products (captain's grill, 2026-11-09). Every
// figure, and the definition of a sale behind it, is in lib/salesDashboard.js. Open
// to every signed-in account, as before. `?month=YYYY-MM` picks the month the daily
// chart, best sellers and slow movers describe (default: this month); a month before
// sales were counted, or one not yet started, is a 400.
router.get('/', async (req, res, next) => {
  try {
    const [sales, { rows: lowStock }] = await Promise.all([
      computeSalesDashboard(db, { month: req.query.month }),
      // Low stock warning (≤ 10 units) — the one panel kept from the old Dashboard.
      db.query(
        `SELECT id, name, category, unit, current_stock
         FROM products
         WHERE current_stock <= 10 AND is_active = TRUE
         ORDER BY current_stock ASC`
      ),
    ]);
    res.json({ ...sales, low_stock: lowStock });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
