const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity, diffFields } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

const MAX_IMAGE_B64_LENGTH = 2_800_000; // ~2 MB before encoding

// GET /api/v1/personnel
router.get('/', async (req, res, next) => {
  try {
    const { include_inactive } = req.query;
    const whereClause = include_inactive === 'true' ? '' : 'WHERE is_active = TRUE';
    // Exclude the heavy image column from list views
    const { rows } = await db.query(
      `SELECT id, full_name, remarks, phone, license_number, is_active, created_at, updated_at
       FROM personnel ${whereClause}
       ORDER BY full_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/personnel
router.post('/', async (req, res, next) => {
  try {
    const { full_name, remarks, phone, license_number, id_image_base64, id_image_mime_type } = req.body;
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });

    if (id_image_base64 && id_image_base64.length > MAX_IMAGE_B64_LENGTH) {
      return res.status(400).json({ error: 'ID image must be under 2 MB' });
    }

    const { rows: [person] } = await db.query(
      `INSERT INTO personnel
         (full_name, remarks, phone, license_number, id_image_base64, id_image_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [full_name, remarks || null, phone || null,
       license_number || null, id_image_base64 || null, id_image_mime_type || null]
    );

    await logActivity(db, {
      entityType: 'personnel',
      entityId:   person.id,
      action:     'created',
      summary:    `Personnel '${person.full_name}' added`,
      performedBy: req.user.id,
    });

    res.status(201).json(person);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/personnel/:id — includes order history
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [person] } = await db.query(
      'SELECT * FROM personnel WHERE id = $1',
      [req.params.id]
    );
    if (!person) return res.status(404).json({ error: 'Personnel not found' });

    const { rows: orderHistory } = await db.query(
      `SELECT
         o.id, o.status, o.total_amount, o.created_at,
         c.name AS customer_name,
         op.role AS role_on_order
       FROM order_personnel op
       JOIN orders o ON o.id = op.order_id
       JOIN customers c ON c.id = o.customer_id
       WHERE op.personnel_id = $1
       ORDER BY o.created_at DESC`,
      [req.params.id]
    );

    res.json({ ...person, order_history: orderHistory });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/personnel/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: [existing] } = await db.query(
      'SELECT * FROM personnel WHERE id = $1',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Personnel not found' });

    const { full_name, remarks, phone, license_number, id_image_base64, id_image_mime_type, is_active } = req.body;

    if (id_image_base64 && id_image_base64.length > MAX_IMAGE_B64_LENGTH) {
      return res.status(400).json({ error: 'ID image must be under 2 MB' });
    }

    const changes = diffFields(existing, req.body, [
      ['full_name', 'Name'],
      ['remarks', 'Remarks'],
      ['phone', 'Phone'],
      ['license_number', 'License number'],
      ['is_active', 'Active status'],
    ]);
    if (id_image_base64 !== undefined && id_image_base64 !== existing.id_image_base64) {
      changes.push('ID image updated');
    }

    const { rows: [person] } = await db.query(
      `UPDATE personnel SET
         full_name          = $1,
         remarks            = $2,
         phone              = $3,
         license_number     = $4,
         id_image_base64    = $5,
         id_image_mime_type = $6,
         is_active          = $7,
         updated_at         = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        full_name          ?? existing.full_name,
        remarks            !== undefined ? remarks            : existing.remarks,
        phone              !== undefined ? phone              : existing.phone,
        license_number     !== undefined ? license_number     : existing.license_number,
        id_image_base64    !== undefined ? id_image_base64    : existing.id_image_base64,
        id_image_mime_type !== undefined ? id_image_mime_type : existing.id_image_mime_type,
        is_active          !== undefined ? is_active          : existing.is_active,
        req.params.id,
      ]
    );

    if (changes.length) {
      await logActivity(db, {
        entityType: 'personnel',
        entityId:   person.id,
        action:     'edited',
        summary:    `Personnel '${person.full_name}': ${changes.join('; ')}`,
        performedBy: req.user.id,
      });
    }

    res.json(person);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/personnel/:id — smart delete: permanently remove if the person has never
// been assigned to an order, otherwise deactivate (order_personnel.personnel_id is RESTRICT,
// so a hard delete of a referenced person would fail and corrupt order history).
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [existing] } = await client.query(
      'SELECT * FROM personnel WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Personnel not found' });
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*) FROM order_personnel WHERE personnel_id = $1',
      [req.params.id]
    );
    const usageCount = Number(count);

    if (usageCount > 0) {
      await client.query(
        'UPDATE personnel SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
        [req.params.id]
      );
      await logActivity(client, {
        entityType: 'personnel',
        entityId:   existing.id,
        action:     'deactivated',
        summary:    `Personnel '${existing.full_name}' deactivated (assigned to ${usageCount} order${usageCount !== 1 ? 's' : ''}; cannot be permanently deleted)`,
        performedBy: req.user.id,
      });
      await client.query('COMMIT');
      return res.json({ outcome: 'deactivated', usageCount });
    }

    // Never assigned to an order — safe to hard delete.
    await client.query('DELETE FROM personnel WHERE id = $1', [req.params.id]);
    await logActivity(client, {
      entityType: 'personnel',
      entityId:   existing.id,
      action:     'deleted',
      summary:    `Personnel '${existing.full_name}' permanently deleted`,
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

module.exports = router;
