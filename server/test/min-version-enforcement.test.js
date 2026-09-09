const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub_v2audit';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const authRoutes = require('../src/routes/auth');
const versionRoutes = require('../src/routes/version');
const { requireAuth } = require('../src/middleware/auth');
const { isBelowMinVersion, clearMinVersionCache, setMinVersionCache } = require('../src/lib/version');
const { errorHandler } = require('../src/middleware/errorHandler');

const PASSWORD = 'leyble123';

describe('Minimum version enforcement flow', () => {
  let server;
  let baseUrl;
  let testUser;
  let authToken;

  before(async () => {
    // Ensure test user exists
    const email = `test-minver-${Date.now()}@leyblestore.com`;
    const hash = await bcrypt.hash(PASSWORD, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, 'MinVer Test', 'admin', TRUE)
       RETURNING id, email, full_name, role`,
      [email, hash]
    );
    testUser = user;

    // Spin up test express app
    const app = express();
    app.use(express.json());
    app.use(cookieParser());

    app.use('/api/v1/version', versionRoutes);
    app.use('/api/v1/auth', authRoutes);

    // Dummy protected route
    app.get('/api/v1/protected-test', requireAuth, (req, res) => {
      res.json({ ok: true, user: req.user });
    });

    app.use(errorHandler);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}/api/v1`;
        resolve();
      });
    });

    // Obtain auth token
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Version': '999.0.0' },
      body: JSON.stringify({ email: testUser.email, password: PASSWORD }),
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(async () => {
    // Restore min_version to NULL (dormant)
    await db.query("UPDATE app_settings SET value = NULL WHERE key = 'min_version'").catch(() => {});
    clearMinVersionCache();
    if (server) await new Promise((r) => server.close(r));
    if (testUser) await db.query('DELETE FROM users WHERE id = $1', [testUser.id]).catch(() => {});
  });

  beforeEach(() => {
    clearMinVersionCache();
  });

  describe('isBelowMinVersion unit logic', () => {
    it('returns false when minVersion is null, undefined, empty, or 0 (dormant)', () => {
      assert.equal(isBelowMinVersion({ version: '1.0.0', build: '1' }, null), false);
      assert.equal(isBelowMinVersion({ version: '1.0.0', build: '1' }, undefined), false);
      assert.equal(isBelowMinVersion({ version: '1.0.0', build: '1' }, ''), false);
      assert.equal(isBelowMinVersion({ version: '1.0.0', build: '1' }, '   '), false);
      assert.equal(isBelowMinVersion({ version: '1.0.0', build: '1' }, '0'), false);
    });

    it('correctly compares semantic versions (versionName)', () => {
      // Below min
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.3.0'), true);
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.2.2'), true);
      assert.equal(isBelowMinVersion({ version: '1.2' }, '1.2.1'), true);
      assert.equal(isBelowMinVersion({ version: '0.9.9' }, '1.0.0'), true);
      assert.equal(isBelowMinVersion('1.2.1', '1.3.0'), true);
      assert.equal(isBelowMinVersion('v1.2.1', '1.3.0'), true);

      // Equal to min (not below)
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.2.1'), false);
      assert.equal(isBelowMinVersion({ version: '1.3.0' }, '1.3'), false);
      assert.equal(isBelowMinVersion('1.3.0', '1.3.0'), false);

      // Above min (not below)
      assert.equal(isBelowMinVersion({ version: '1.3.1' }, '1.3.0'), false);
      assert.equal(isBelowMinVersion({ version: '2.0.0' }, '1.3.0'), false);
      assert.equal(isBelowMinVersion({ version: '1.10.0' }, '1.9.0'), false);
    });

    it('correctly compares numeric build codes (versionCode)', () => {
      // Below min
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, '5'), true);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: 13 }, '14'), true);
      assert.equal(isBelowMinVersion({ build: '3' }, '4'), true);

      // Equal to min
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '5' }, '5'), false);
      assert.equal(isBelowMinVersion({ build: '14' }, '14'), false);

      // Above min
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '6' }, '5'), false);
      assert.equal(isBelowMinVersion({ build: 20 }, '14'), false);
    });

    it('treats missing installed version on active enforcement as below minimum', () => {
      assert.equal(isBelowMinVersion(null, '1.3.0'), true);
      assert.equal(isBelowMinVersion({}, '1.3.0'), true);
      assert.equal(isBelowMinVersion({ version: '' }, '1.3.0'), true);
      assert.equal(isBelowMinVersion(null, '15'), true);
    });
  });

  describe('GET /api/v1/version', () => {
    it('returns min_version: null when dormant', async () => {
      await db.query("UPDATE app_settings SET value = NULL WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/version`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.min_version, null);
    });

    it('returns min_version value when configured in database', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/version`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.min_version, '1.3.0');
    });
  });

  describe('Server-side enforcement on protected endpoints', () => {
    it('allows requests when enforcement is dormant (min_version is null)', async () => {
      await db.query("UPDATE app_settings SET value = NULL WHERE key = 'min_version'");
      clearMinVersionCache();

      // No header
      const res1 = await fetch(`${baseUrl}/protected-test`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res1.status, 200);

      // Any version header
      const res2 = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.0.0',
        },
      });
      assert.equal(res2.status, 200);
    });

    it('rejects protected requests with 426 when version is below minimum', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.2.1',
        },
      });
      assert.equal(res.status, 426);
      const data = await res.json();
      assert.equal(data.code, 'update_required');
      assert.equal(data.min_version, '1.3.0');
      assert.match(data.error, /update required/i);
    });

    it('rejects protected requests with 426 when version header is missing on active enforcement', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      assert.equal(res.status, 426);
      const data = await res.json();
      assert.equal(data.code, 'update_required');
    });

    it('accepts protected requests when version meets or exceeds minimum', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      // Equal
      const resEqual = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.3.0',
        },
      });
      assert.equal(resEqual.status, 200);

      // Higher
      const resHigher = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.4.0',
        },
      });
      assert.equal(resHigher.status, 200);
    });

    it('enforces build number when min_version is an integer', async () => {
      await db.query("UPDATE app_settings SET value = '15' WHERE key = 'min_version'");
      clearMinVersionCache();

      // Lower build rejected
      const resLow = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.2.1',
          'X-App-Build': '14',
        },
      });
      assert.equal(resLow.status, 426);

      // Equal build accepted
      const resEqual = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.2.1',
          'X-App-Build': '15',
        },
      });
      assert.equal(resEqual.status, 200);

      // Higher build accepted
      const resHigh = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': '1.2.1',
          'X-App-Build': '16',
        },
      });
      assert.equal(resHigh.status, 200);
    });

    it('exempts dev/test client headers in non-production', async () => {
      await db.query("UPDATE app_settings SET value = '99.0.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/protected-test`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-App-Version': 'dev',
        },
      });
      assert.equal(res.status, 200);
    });
  });

  describe('Server-side enforcement on /auth/login', () => {
    it('rejects login with 426 when app version is below minimum', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Version': '1.2.1',
        },
        body: JSON.stringify({ email: testUser.email, password: PASSWORD }),
      });
      assert.equal(res.status, 426);
      const data = await res.json();
      assert.equal(data.code, 'update_required');
    });

    it('allows login to authenticate when app version meets minimum', async () => {
      await db.query("UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version'");
      clearMinVersionCache();

      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Version': '1.3.0',
        },
        body: JSON.stringify({ email: testUser.email, password: PASSWORD }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
    });
  });
});
