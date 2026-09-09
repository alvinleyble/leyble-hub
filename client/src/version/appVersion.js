import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

// Default / fallback metadata matching current build.gradle
const DEFAULT_VERSION = '1.2.1';
const DEFAULT_BUILD = '4';
const DEFAULT_APP_ID = 'com.leyble.hub';

let cachedAppInfo = {
  version: DEFAULT_VERSION,
  build: DEFAULT_BUILD,
  id: DEFAULT_APP_ID,
};

let mockAppInfo = null;
let mockPlayStoreOpener = null;

/**
 * Pure version comparison: determines whether an installed version/build
 * is below the required minimum version.
 *
 * Supports:
 * - Integer build numbers (versionCode, e.g. "4", "14")
 * - Semantic version strings (versionName, e.g. "1.2.1", "1.3.0")
 */
export function isBelowMinVersion(installed, minVersion) {
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
    if (buildStr && /^\d+$/.test(buildStr)) {
      return parseInt(buildStr, 10) < minBuild;
    }
    if (versionStr && /^\d+$/.test(versionStr)) {
      return parseInt(versionStr, 10) < minBuild;
    }
    if (!versionStr && !buildStr) {
      return true;
    }
    return true;
  }

  // Case 2: minVersion is semver (e.g. "1.3.0" or "1.2")
  if (!versionStr) {
    return true;
  }

  const parseSemver = (str) => {
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

  return false;
}

/**
 * Loads native app info if running in Capacitor, or uses defaults/mock in browser/tests.
 */
export async function getAppInfo() {
  if (mockAppInfo) return mockAppInfo;

  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      cachedAppInfo = {
        version: info.version || DEFAULT_VERSION,
        build: info.build || DEFAULT_BUILD,
        id: info.id || DEFAULT_APP_ID,
      };
    } catch {
      // Keep cached / default values if plugin call fails
    }
  }
  return cachedAppInfo;
}

/**
 * Synchronous accessors for HTTP request headers in api/client.js.
 */
export function getAppVersion() {
  return mockAppInfo?.version || cachedAppInfo.version;
}

export function getAppBuild() {
  return mockAppInfo?.build || cachedAppInfo.build;
}

export function getAppId() {
  return mockAppInfo?.id || cachedAppInfo.id;
}

/**
 * Open the Google Play Store listing for internal testing / distribution.
 */
export function openPlayStore(appId) {
  const id = appId || getAppId();
  if (mockPlayStoreOpener) {
    mockPlayStoreOpener(id);
    return;
  }

  const playStoreUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`;
  const marketUrl = `market://details?id=${encodeURIComponent(id)}`;

  if (Capacitor.isNativePlatform()) {
    try {
      window.location.href = marketUrl;
      setTimeout(() => {
        window.location.href = playStoreUrl;
      }, 500);
      return;
    } catch {}
  }

  if (typeof window !== 'undefined') {
    window.open(playStoreUrl, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Test seams
 */
export function setMockAppInfo(info) {
  mockAppInfo = info ? { ...info } : null;
}

export function setMockPlayStoreOpener(fn) {
  mockPlayStoreOpener = fn;
}
