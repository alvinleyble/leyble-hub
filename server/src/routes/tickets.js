const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity, diffFields } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

const TICKET_JOIN = `
  FROM tickets t
  LEFT JOIN orders o      ON o.id = t.related_order_id
  LEFT JOIN personnel p   ON p.id = t.related_personnel_id
  LEFT JOIN users uc      ON uc.id = t.created_by
  LEFT JOIN users ur      ON ur.id = t.resolved_by
`;

// GET /api/v1/tickets
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('t.status = $1');
      params.push(status);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT t.*,
              p.full_name  AS personnel_name,
              uc.full_name AS created_by_name,
              ur.full_name AS resolved_by_name
       ${TICKET_JOIN}
       ${whereClause}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/tickets
router.post('/', async (req, res, next) => {
  try {
    const { title, description, related_order_id, related_personnel_id, amount } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }

    const { rows: [ticket] } = await db.query(
      `INSERT INTO tickets (title, description, related_order_id, related_personnel_id, amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description, related_order_id || null, related_personnel_id || null,
       amount !== undefined ? amount : null, req.user.id]
    );

    await logActivity(db, {
      entityType: 'ticket',
      entityId:   ticket.id,
      action:     'created',
      summary:    `Ticket '${ticket.title}' created`,
      performedBy: req.user.id,
    });

    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/tickets/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [ticket] } = await db.query(
      `SELECT t.*,
              p.full_name  AS personnel_name,
              uc.full_name AS created_by_name,
              ur.full_name AS resolved_by_name
       ${TICKET_JOIN}
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/tickets/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: [existing] } = await db.query(
      'SELECT * FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    if (existing.status === 'resolved') {
      return res.status(422).json({ error: 'Resolved tickets cannot be modified' });
    }

    const { title, description, amount, status, resolution_notes } = req.body;

    const isResolving = status === 'resolved';

    const changes = diffFields(existing, req.body, [
      ['title',            'Title'],
      ['description',      'Description'],
      ['amount',           'Amount'],
      ['resolution_notes', 'Resolution notes'],
    ]);

    const { rows: [ticket] } = await db.query(
      `UPDATE tickets SET
         title            = $1,
         description      = $2,
         amount           = $3,
         status           = $4,
         resolution_notes = $5,
         resolved_by      = $6,
         resolved_at      = $7,
         updated_at       = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        title            ?? existing.title,
        description      ?? existing.description,
        amount           !== undefined ? amount           : existing.amount,
        status           ?? existing.status,
        resolution_notes !== undefined ? resolution_notes : existing.resolution_notes,
        isResolving ? req.user.id    : existing.resolved_by,
        isResolving ? new Date()     : existing.resolved_at,
        req.params.id,
      ]
    );

    if (changes.length && !isResolving) {
      await logActivity(db, {
        entityType: 'ticket',
        entityId:   ticket.id,
        action:     'edited',
        summary:    `Ticket #${ticket.id}: ${changes.join('; ')}`,
        performedBy: req.user.id,
      });
    }

    if (isResolving) {
      await logActivity(db, {
        entityType: 'ticket',
        entityId:   ticket.id,
        action:     'resolved',
        summary:    `Ticket #${ticket.id} '${ticket.title}' resolved`,
        performedBy: req.user.id,
      });
    }

    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
