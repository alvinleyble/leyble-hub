const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// No JWT_EXPIRES_IN in production — the session never expires, since the app only ships as
// an APK on a couple of shared devices and re-entering credentials adds no real security
// benefit there. Set JWT_EXPIRES_IN explicitly (e.g. '1y') if a bounded session is wanted.
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 10 * 365 * 24 * 60 * 60 * 1000, // ~10 years, for the local-dev cookie path
};

// What the client is allowed to see of a session. The `sid` claim (ADR 0017 #8) stays
// inside the signed token and is never handed back as data: nothing on the device needs
// to read it, and AuthContext persists whatever this returns.
function publicIdentity({ id, email, full_name, role }) {
  return { id, email, full_name, role };
}

// POST /api/v1/auth/login  { email, password, device_key? }
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, device_key } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { rows: [user] } = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase().trim()]
    );

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // ADR 0017 #8 — one session per account. Signing in here ends this account's session
    // on every other device, because `requireAuth` refuses any token carrying an older
    // `sid`. It cannot reach a device that is offline: that device never hears it, keeps
    // selling under the receipt numbers it already holds, and is asked to sign in again
    // on reconnect. Receipt uniqueness never depends on this (ADR 0017 #2), and the
    // receipts it is holding are device state that survive being signed out (ADR 0015 §3).
    //
    // A device_key is optional and purely descriptive — it records WHERE the live session
    // is, so a person whose session was ended can be told something better than "signed
    // out". A client that does not send one (an old APK, or a first run that has not
    // registered yet) is not treated differently in any way.
    const deviceKey = typeof device_key === 'string' && device_key.trim()
      ? device_key.trim().slice(0, 64)
      : null;
    const sessionId = crypto.randomUUID();
    const replacedSession = Boolean(user.session_id)
      && (!deviceKey || !user.session_device || user.session_device !== deviceKey);

    await db.query(
      `UPDATE users SET session_id = $2, session_device = $3, session_started_at = NOW()
        WHERE id = $1`,
      [user.id, sessionId, deviceKey]
    );

    const identity = publicIdentity(user);
    const signOpts = process.env.JWT_EXPIRES_IN ? { expiresIn: process.env.JWT_EXPIRES_IN } : {};
    const token = jwt.sign({ ...identity, sid: sessionId }, process.env.JWT_SECRET, signOpts);

    // Cookie for the web (dev) client; `token` in the body for the native
    // Android app, which stores it and sends it as an Authorization header. Since
    // ADR 0017 #7 the device also keeps that token against this account in its
    // remembered-accounts list, which is what makes switching back to it offline two
    // taps and no password.
    res.cookie('jwt', token, COOKIE_OPTS)
       .json({ ...identity, token, session_replaced: replacedSession });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout
//
// Deliberately unauthenticated — a logout must work even when the token is already
// refused (a superseded session is exactly that case). The session row is cleared only
// when the caller actually holds the live session's token, so signing out on the tablet
// you just left cannot end the session you have since started somewhere else.
router.post('/logout', async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer || req.cookies?.jwt;
    if (token) {
      try {
        const claims = jwt.verify(token, process.env.JWT_SECRET);
        if (claims?.sid) {
          await db.query(
            'UPDATE users SET session_id = NULL, session_device = NULL WHERE id = $1 AND session_id = $2',
            [claims.id, claims.sid]
          );
        }
      } catch {
        // An unreadable or already-superseded token still logs the device out locally.
      }
    }
    res.clearCookie('jwt', { ...COOKIE_OPTS, maxAge: 0 }).json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json(publicIdentity(req.user));
});

module.exports = router;
