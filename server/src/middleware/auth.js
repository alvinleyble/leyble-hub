const jwt = require('jsonwebtoken');
const db = require('../db');

// Login is now restricted to a single shared account, but the app still needs to know
// *who* (Josie / Luis / Admin) is actually driving it — see migration 030 (users.profile_key).
// The frontend sends the chosen profile as X-Active-Profile on every request; we swap the
// JWT identity for that profile's so downstream code (activity_logs.performed_by, GET
// /auth/me, etc.) needs no changes. Cached forever — profile_key assignments essentially
// never change while the server is running.
let profileCache = null;

async function loadProfiles() {
  if (!profileCache) {
    const { rows } = await db.query(
      `SELECT profile_key, id, full_name FROM users WHERE profile_key IS NOT NULL`
    );
    profileCache = new Map(rows.map((r) => [r.profile_key, r]));
  }
  return profileCache;
}

async function requireAuth(req, res, next) {
  // Web (dev) sends the JWT in an HTTP-only cookie; the native Android app
  // (Capacitor WebView) can't use SameSite=strict cookies cross-origin, so it
  // sends the same token in an Authorization: Bearer header instead.
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = req.cookies?.jwt || bearer;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const activeProfile = req.headers['x-active-profile'];
  if (activeProfile) {
    const profiles = await loadProfiles();
    const profile = profiles.get(activeProfile);
    if (!profile) return res.status(400).json({ error: `Unknown profile '${activeProfile}'` });
    req.user = { ...req.user, id: profile.id, full_name: profile.full_name };
  }

  next();
}

module.exports = { requireAuth };
