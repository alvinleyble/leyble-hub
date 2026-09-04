const jwt = require('jsonwebtoken');
const db = require('../db');

// ADR 0017 #8 — one session per account. A token carries the session it was minted for
// (`sid`), login mints a fresh one, and a token whose `sid` is no longer the one on the
// row is refused with `code: 'session_superseded'` so the client can say something more
// useful than "signed out".
//
// What this deliberately does NOT do:
//
//   • It is never load-bearing for receipt uniqueness. A takeover is a SERVER-SIDE act,
//     so an offline tablet never hears it, keeps selling, and finds out on reconnect.
//     Uniqueness comes from the per-person device letter alone (ADR 0017 #2).
//   • It never reaches the outbox. A 401 here clears session state on the device and
//     nothing else — receipts waiting to sync are device state and survive it
//     (ADR 0015 §3, and the hard requirement in ADR 0017 #8).
//   • It does not refuse a token with no `sid`. Every token minted before this slice has
//     none, and tablets are updated one at a time over several days (ADR 0017 #13): a
//     device still on the old build has to keep selling. Those tokens are checked for
//     the account still existing and still being active, and nothing more.
const SESSION_SUPERSEDED = 'session_superseded';

async function requireAuth(req, res, next) {
  // Web (dev) sends the JWT in an HTTP-only cookie; the native Android app
  // (Capacitor WebView) can't use SameSite=strict cookies cross-origin, so it
  // sends the same token in an Authorization: Bearer header instead.
  //
  // ADR 0017 §5: the JWT is the whole identity. There is no profile picker and no
  // `X-Active-Profile` swap any more — each person signs in with their own account,
  // so `req.user.id` (and therefore `activity_logs.performed_by`) is whoever signed
  // in on this device. An `X-Active-Profile` header from a pre-0017 client is simply
  // ignored rather than rejected, so an old APK keeps working while tablets update.
  //
  // Bearer wins over the cookie since ADR 0017 #7. On a browser one cookie can only
  // ever name one account, so a device holding a remembered account's own token has to
  // be able to speak as that account explicitly — which is also how the outbox drains
  // each queued record under the account that SAVED it rather than whoever happens to
  // be holding the tablet when the line returns (D14).
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.jwt;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  let row;
  try {
    ({ rows: [row] } = await db.query(
      'SELECT id, is_active, session_id FROM users WHERE id = $1', [claims.id]
    ));
  } catch {
    // FAIL OPEN on an infrastructure error, never closed. A database hiccup must not
    // sign every tablet in the store out at once — a signed token is still proof of a
    // sign-in, and whatever the request was about to do will fail on its own query
    // anyway, loudly and recoverably.
    req.user = claims;
    return next();
  }

  if (!row || !row.is_active) {
    // ADR 0017 #1 — accounts are deactivated, never deleted. Deactivating one has to
    // actually end its access, or the only thing "deactivated" would mean is that the
    // password stops working on devices that do not already hold a token.
    return res.status(401).json({ error: 'This account is no longer active. Ask for it to be re-enabled.' });
  }

  if (claims.sid && claims.sid !== row.session_id) {
    return res.status(401).json({
      error: 'This account was signed in on another device. Sign in again to keep using it here.',
      code: SESSION_SUPERSEDED,
    });
  }

  req.user = claims;
  next();
}

module.exports = { requireAuth, SESSION_SUPERSEDED };
