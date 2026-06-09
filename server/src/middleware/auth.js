const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  // Web (dev) sends the JWT in an HTTP-only cookie; the native Android app
  // (Capacitor WebView) can't use SameSite=strict cookies cross-origin, so it
  // sends the same token in an Authorization: Bearer header instead.
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = req.cookies?.jwt || bearer;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireAuth };
