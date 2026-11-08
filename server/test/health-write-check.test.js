// GET /api/v1/health/write — the offline outbox only holds a 5xx against a queued record
// once this says the database is accepting writes (Supabase flips a full database to
// read-only, and then every record would 5xx). Runs against a throwaway database.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub_v2audit';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const healthRoutes = require('../src/routes/health');
const { checkDatabaseWritable } = require('../src/lib/writeCheck');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('database write check', () => {
  let server;
  let baseUrl;
  let token;
  let userId;

  before(async () => {
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, 'x', 'Write Check Test', 'admin', TRUE)
       RETURNING id, email, full_name, role`,
      [`test-writecheck-${Date.now()}@leyblestore.com`],
    );
    userId = user.id;
    token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/health', healthRoutes);
    app.use(errorHandler);
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  it('answers 200 when the database accepts writes', async () => {
    const res = await fetch(`${baseUrl}/health/write`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', writable: true });
  });

  it('requires a signed-in account', async () => {
    const res = await fetch(`${baseUrl}/health/write`);
    assert.equal(res.status, 401);
  });

  it('changes no data and leaves no table behind', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'leyble_write_check'`);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/health/write`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
    }
    const afterRows = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'leyble_write_check'`);
    assert.equal(afterRows.rows[0].n, before.rows[0].n);
  });

  it('fails when the session is read-only, as Supabase sets a full database', async () => {
    const client = await db.connect();
    try {
      await client.query('SET SESSION default_transaction_read_only = on');
      await assert.rejects(() => checkDatabaseWritable(client), (err) => {
        assert.equal(err.code, '25006'); // read_only_sql_transaction
        return true;
      });
      // The probe always leaves the connection usable and outside a transaction.
      const { rows: [row] } = await client.query('SELECT 1 AS ok');
      assert.equal(row.ok, 1);
    } finally {
      await client.query('RESET default_transaction_read_only').catch(() => {});
      client.release();
    }
  });

  it('passes on the same connection once it is writable again', async () => {
    const client = await db.connect();
    try {
      await checkDatabaseWritable(client);
    } finally {
      client.release();
    }
  });
});
