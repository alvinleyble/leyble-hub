const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// D1 — a device learns its station number by registering with the server once, at
// install. The server hands out the next free number; the device stores it
// permanently in native storage and prefixes every receipt it issues with it.
//
// Manual station selection was rejected: one careless tap gives two devices the same
// number space, and the collision only shows up on paper in a customer's hand.
//
// POST /api/v1/stations/register  { device_key, label? }
router.post('/register', async (req, res, next) => {
  const { device_key, label } = req.body || {};

  if (typeof device_key !== 'string' || !device_key.trim()) {
    return res.status(400).json({ error: 'device_key is required' });
  }
  const deviceKey = device_key.trim();
  if (deviceKey.length > 64) {
    return res.status(400).json({ error: 'device_key must be 64 characters or fewer' });
  }

  try {
    // Registration is idempotent on device_key. The device calls this on every start
    // until it has a station stored, and a reinstall that lost the response must not
    // be able to hand the same physical device two number spaces.
    const { rows: [existing] } = await db.query(
      `UPDATE stations SET last_seen_at = NOW(), label = COALESCE($2, label)
        WHERE device_key = $1
        RETURNING station_number, device_key, label, registered_at`,
      [deviceKey, label || null]
    );
    if (existing) return res.json({ ...existing, created: false });

    // ON CONFLICT covers two devices (or two starts of one device) racing here. It
    // burns a sequence value when it fires; gaps are harmless — D1 only requires
    // that numbers never come back down or repeat.
    const { rows: [created] } = await db.query(
      `INSERT INTO stations (device_key, label)
       VALUES ($1, $2)
       ON CONFLICT (device_key) DO UPDATE SET last_seen_at = NOW()
       RETURNING station_number, device_key, label, registered_at`,
      [deviceKey, label || null]
    );
    res.status(201).json({ ...created, created: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/stations — the registered devices, newest number last. Read-only;
// used by the build-side verification of D1 and by nothing the owners can reach.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT station_number, device_key, label, registered_at, last_seen_at
         FROM stations ORDER BY station_number`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
