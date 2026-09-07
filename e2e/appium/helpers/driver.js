// Shared Appium/WebDriver connection helpers for every test in this suite.
// See ../README.md for the full run sequence (emulator, backend, APK, Appium server).

import { remote } from 'webdriverio';

const APPIUM_HOSTNAME = 'localhost';
const APPIUM_PORT = 4723;
const APPIUM_PATH = '/wd/hub';

export function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}

// Same capabilities every test connects with — attaches to the already-installed debug
// APK (appium:noReset) rather than reinstalling/wiping it, so a human poking at the same
// device isn't disrupted. See README "Clean state matters" for why `pm clear` before a
// run is still required.
export async function createDriver() {
  return remote({
    hostname: APPIUM_HOSTNAME,
    port: APPIUM_PORT,
    path: APPIUM_PATH,
    logLevel: 'warn',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': 'com.leyble.hub',
      'appium:appActivity': '.MainActivity',
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': 180,
    },
  });
}

// A Capacitor app's entire UI lives in one WebView, named WEBVIEW_<appPackage> once the
// page attaches. The native context (NATIVE_APP) is where the session starts.
export async function switchToWebview(driver) {
  await driver.waitUntil(
    async () => {
      const contexts = await driver.getContexts();
      return contexts.some((c) => String(c).toUpperCase().includes('WEBVIEW'));
    },
    { timeout: 30000, timeoutMsg: 'no WEBVIEW context appeared within 30s' }
  );
  const contexts = await driver.getContexts();
  const webviewContext = contexts.find((c) => String(c).toUpperCase().includes('WEBVIEW'));
  console.log('Found webview context:', webviewContext);
  await driver.switchContext(webviewContext);
  return webviewContext;
}

// Runs `fn(driver)` inside a connected, webview-switched session and always tears the
// session down afterwards — the shape every test in this suite follows.
export async function withSession(fn) {
  const driver = await createDriver();
  try {
    await switchToWebview(driver);
    await fn(driver);
  } finally {
    await driver.deleteSession();
  }
}
