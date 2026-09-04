// ADR 0017 slice 5, server half — one session per account.
//
// The decision is deliberately narrow, and the tests below are shaped by what it says it
// CANNOT do as much as by what it can:
//
//   • It can end an account's session on other devices when that account signs in
//     somewhere new.
//   • It cannot reach a device that is offline. A takeover is a server-side act, so a
//     blind tablet never hears it, keeps selling, and finds out on reconnect.
//   • It is NEVER load-bearing for receipt uniqueness — that comes from the per-person
//     device letter alone (ADR 0017 #2), which is why the paragraph above is tolerable.
//   • It must never cost a device the receipts it is holding. That half is device state
//     and is tested in client/test/v3-s5-offline-switching.test.mjs.
//
// And one compatibility rule that is easy to break and expensive to notice: a token
// minted before this slice carries no `sid` at all, and must keep working. Tablets are
// updated one at a time over several days (ADR 0017 #13); refusing those tokens would
// stop the un-updated ones selling.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const authRoutes = require('../src/routes/auth');
const { requireAuth, SESSION_SUPERSEDED } = require('../src/middleware/auth');
const { errorHandler } = require('../src/middleware/errorHandler');

const PASSWORD = 'leyble123';

describe('ADR 0017 slice 5 — one session per account', () => {
  let server;
  let baseUrl;
  let user;
  const createdUserIds = [];

  const login = async (body) => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
  };

  const me = async (headers) => {
    const res = await fetch(`${baseUrl}/auth/me`, { headers });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    const email = `test-s5-${Date.now()}-${Math.floor(Math.random() * 1e6)}@leyblestore.com`;
    const { rows: [row] } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, 'S5 Person', 'admin', TRUE) RETURNING id, email, full_name, role`,
      [email, await bcrypt.hash(PASSWORD, 10)]
    );
    user = row;
    createdUserIds.push(row.id);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', authRoutes);
    // A stand-in for every other route in the app: all of them sit behind requireAuth,
    // and this suite is about what requireAuth now lets through.
    app.get('/api/v1/guarded', requireAuth, (req, res) => res.json({ id: req.user.id }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (createdUserIds.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // ── Signing in somewhere new ends the session everywhere else ─────────────

  it('mints a session on sign-in and hands the device a token that works', async () => {
    const { status, body } = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    assert.equal(status, 200);
    assert.ok(body.token, 'the native app gets its bearer token in the body');
    assert.equal(body.session_replaced, false, 'nothing to replace on a first sign-in');

    const check = await me({ Authorization: `Bearer ${body.token}` });
    assert.equal(check.status, 200);
    assert.equal(check.body.id, user.id);
  });

  it('never hands the session id back as data', async () => {
    const { body } = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    assert.equal(body.sid, undefined, 'it lives inside the signed token; nothing on the device reads it');
    const check = await me({ Authorization: `Bearer ${body.token}` });
    assert.equal(check.body.sid, undefined);
  });

  it('signing in on a second device supersedes the first', async () => {
    const first = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    const second = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-B' });

    assert.equal(second.body.session_replaced, true, 'and it says so, rather than the other tablet just stopping');

    const old = await me({ Authorization: `Bearer ${first.body.token}` });
    assert.equal(old.status, 401);
    assert.equal(old.body.code, SESSION_SUPERSEDED,
      'a distinguishable code, so the login screen can explain the sign-out instead of just showing a form');

    const current = await me({ Authorization: `Bearer ${second.body.token}` });
    assert.equal(current.status, 200, 'the device that signed in most recently is the one that keeps working');
  });

  it('signing in again on the SAME device is not a takeover', async () => {
    await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    const again = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    assert.equal(again.body.session_replaced, false);
  });

  it('guards every ordinary route the same way, not just /auth/me', async () => {
    const first = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-B' });

    const res = await fetch(`${baseUrl}/guarded`, {
      headers: { Authorization: `Bearer ${first.body.token}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, SESSION_SUPERSEDED);
  });

  // ── The switchover window (ADR 0017 #13) ─────────────────────────────────

  it('accepts a pre-slice-5 token that carries no session at all', async () => {
    await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-B' });

    // Exactly what a tablet still on the old build is holding: the old payload, no `sid`.
    const legacy = jwt.sign(
      { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
      process.env.JWT_SECRET
    );
    const check = await me({ Authorization: `Bearer ${legacy}` });
    assert.equal(check.status, 200,
      'tablets are updated one at a time over several days — an un-updated one has to keep selling');
  });

  it('refuses any token for an account that has been deactivated', async () => {
    const { body } = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    await db.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
    try {
      const check = await me({ Authorization: `Bearer ${body.token}` });
      assert.equal(check.status, 401,
        'ADR 0017 #1 deactivates accounts rather than deleting them; that has to actually end access');
    } finally {
      await db.query('UPDATE users SET is_active = TRUE WHERE id = $1', [user.id]);
    }
  });

  // ── Bearer beats the cookie (ADR 0017 #7) ────────────────────────────────

  it('an explicit bearer token wins over whatever the cookie says', async () => {
    // One browser cookie can only ever name one account, so a device that remembers two
    // has to be able to say which one is speaking — this is what makes the outbox able to
    // drain each record under the account that saved it.
    const other = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, 'S5 Other', 'admin', TRUE) RETURNING id, email`,
      [`test-s5-other-${Date.now()}@leyblestore.com`, await bcrypt.hash(PASSWORD, 10)]
    );
    createdUserIds.push(other.rows[0].id);

    const cookieHolder = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    const cookie = cookieHolder.setCookie.split(';')[0];
    const bearerHolder = await login({ email: other.rows[0].email, password: PASSWORD, device_key: 'S5-TABLET-C' });

    const res = await fetch(`${baseUrl}/guarded`, {
      headers: { Cookie: cookie, Authorization: `Bearer ${bearerHolder.body.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, other.rows[0].id, 'the bearer token is the one that counts');
  });

  // ── Logging out ──────────────────────────────────────────────────────────

  it('logging out ends the session it actually holds', async () => {
    const { body } = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    const out = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${body.token}` },
    });
    assert.equal(out.status, 200);

    const check = await me({ Authorization: `Bearer ${body.token}` });
    assert.equal(check.status, 401, 'the token it was holding is dead');

    const { rows: [row] } = await db.query('SELECT session_id FROM users WHERE id = $1', [user.id]);
    assert.equal(row.session_id, null);
  });

  it('logging out with a superseded token cannot end the session that replaced it', async () => {
    const first = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-A' });
    const second = await login({ email: user.email, password: PASSWORD, device_key: 'S5-TABLET-B' });

    // The stale tablet reconnects, is bounced to the login screen, and logs out on its
    // way there. That must not sign the tablet in someone's hand out.
    const out = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${first.body.token}` },
    });
    assert.equal(out.status, 200, 'a logout always succeeds locally, even holding a refused token');

    const check = await me({ Authorization: `Bearer ${second.body.token}` });
    assert.equal(check.status, 200, 'the live session is untouched');
  });
});
