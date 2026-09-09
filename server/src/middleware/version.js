const { getMinVersion, isBelowMinVersion } = require('../lib/version');

const UPDATE_REQUIRED = 'update_required';

/**
 * Middleware enforcing the minimum Android app version for protected requests.
 *
 * Rejects requests from app versions below the configured minimum with 426 Upgrade Required.
 * Leaves enforcement dormant if min_version is NULL or empty in app_settings.
 */
async function requireMinVersion(req, res, next) {
  let minVersion;
  try {
    minVersion = await getMinVersion();
  } catch {
    // FAIL OPEN on infrastructure error
    return next();
  }

  // Dormant when not set
  if (!minVersion) {
    return next();
  }

  const clientVersion = req.headers['x-app-version'];
  const clientBuild = req.headers['x-app-build'];

  // Dev tier exemption in non-production environments (ADR 0011 browser dev)
  const isDevHeader = clientVersion === 'dev' || clientVersion === 'test';
  const isDevBrowser = process.env.NODE_ENV !== 'production' && req.cookies?.jwt && !req.headers.authorization;
  if (isDevHeader || isDevBrowser) {
    return next();
  }

  if (!clientVersion || isBelowMinVersion({ version: clientVersion, build: clientBuild }, minVersion)) {
    return res.status(426).json({
      error: 'App update required. Please update Leyble Hub to continue.',
      code: UPDATE_REQUIRED,
      min_version: minVersion,
    });
  }

  next();
}

module.exports = {
  requireMinVersion,
  UPDATE_REQUIRED,
};
