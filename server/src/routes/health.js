const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkDatabaseWritable } = require('../lib/writeCheck');

const router = express.Router();

/**
 * GET /api/v1/health/write — 200 when the database currently accepts writes, 503 when
 * it does not. Changes no data (see lib/writeCheck.js). The offline outbox calls it
 * after a queued record gets a 5xx, and only a 2xx lets that failure count toward
 * moving the record to Needs attention.
 */
router.get('/write', requireAuth, async (req, res) => {
  let client;
  try {
    client = await db.connect();
    await checkDatabaseWritable(client);
    res.json({ status: 'ok', writable: true });
  } catch (err) {
    console.error('[health/write] database is not accepting writes:', err.code || '', err.message);
    res.status(503).json({ error: 'Database is not accepting writes', code: 'db_not_writable' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
