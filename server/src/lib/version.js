const db = require('../db');

// Cache min_version in memory to avoid round-trip latency on protected requests.
// Production API sits ~200ms from the database, so querying the DB on every single
// write or read would exhaust write budgets.
const CACHE_TTL_MS = 30_000; // 30 seconds
let cachedMinVersion = null;
let cacheExpiresAt = 0;

/**
 * Pure comparison: determines whether an installed app version or build is below the required minimum version.
 *
 * Supports both:
 * 1. Integer build numbers (Android versionCode, e.g. "4", "14")
 * 2. Semantic version strings (Android versionName, e.g. "1.2.1", "1.3.0")
 *
 * @param {Object|string} installed - { version: string, build: string|number } or version string
 * @param {string|null} minVersion - The minimum version string from app_settings
 * @returns {boolean} True if installed is strictly below minVersion, false otherwise
 */
function isBelowMinVersion(installed, minVersion) {
  if (!minVersion || typeof minVersion !== 'string') return false;
  const target = minVersion.trim();
  if (!target || target === '0') return false;

  const versionStr = typeof installed === 'string'
    ? installed
    : (installed?.version ? String(installed.version) : '');
  const buildStr = typeof installed === 'object' && installed?.build !== undefined && installed?.build !== null
    ? String(installed.build)
    : '';

  // Case 1: minVersion is purely numeric (targeting Android versionCode / build number)
  if (/^\d+$/.test(target)) {
    const minBuild = parseInt(target, 10);
    // If build is supplied, compare directly against build
    if (buildStr && /^\d+$/.test(buildStr)) {
      return parseInt(buildStr, 10) < minBuild;
    }
    // If versionStr is also purely numeric
    if (versionStr && /^\d+$/.test(versionStr)) {
      return parseInt(versionStr, 10) < minBuild;
    }
    // Target is numeric build but installed version has no valid build or numeric version
    if (!versionStr && !buildStr) {
      return true; // Missing version on active enforcement -> below minimum
    }
    // If installed version is semver but min is numeric build number:
    // cannot satisfy numeric build requirement without build number
    return true;
  }

  // Case 2: minVersion is semver (e.g. "1.3.0" or "1.2")
  if (!versionStr) {
    return true; // Missing version on active enforcement -> below minimum
  }

  const parseSemver = (str) => {
    // Strip leading 'v' or build metadata like '+build'
    const clean = str.replace(/^v/, '').split('+')[0];
    return clean.split('.').map((part) => {
      const num = parseInt(part, 10);
      return Number.isNaN(num) ? 0 : num;
    });
  };

  const installedParts = parseSemver(versionStr);
  const minParts = parseSemver(target);
  const maxLen = Math.max(installedParts.length, minParts.length);

  for (let i = 0; i < maxLen; i++) {
    const a = installedParts[i] || 0;
    const b = minParts[i] || 0;
    if (a < b) return true;
    if (a > b) return false;
  }

  return false; // Equal to minimum version
}

/**
 * Retrieve the current minimum required app version from app_settings.
 * Fails open (returns cached or null) on infrastructure / database errors.
 */
async function getMinVersion() {
  const now = Date.now();
  if (cacheExpiresAt > now) {
    return cachedMinVersion;
  }

  try {
    const { rows } = await db.query(
      "SELECT value FROM app_settings WHERE key = 'min_version' LIMIT 1"
    );
    const value = rows[0]?.value ? rows[0].value.trim() : null;
    cachedMinVersion = value || null;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedMinVersion;
  } catch (err) {
    // FAIL OPEN on infrastructure error (consistent with requireAuth in auth.js)
    return cachedMinVersion || null;
  }
}

/**
 * Test seams to inspect or control min_version cache.
 */
function setMinVersionCache(value, ttlMs = CACHE_TTL_MS) {
  cachedMinVersion = value || null;
  cacheExpiresAt = Date.now() + ttlMs;
}

function clearMinVersionCache() {
  cachedMinVersion = null;
  cacheExpiresAt = 0;
}

module.exports = {
  isBelowMinVersion,
  getMinVersion,
  setMinVersionCache,
  clearMinVersionCache,
};
