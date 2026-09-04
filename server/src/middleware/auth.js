const jwt = require('jsonwebtoken');

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
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = req.cookies?.jwt || bearer;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  next();
}

module.exports = { requireAuth };
