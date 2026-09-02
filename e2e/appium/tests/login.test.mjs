// Appium proof-of-concept / reusable login test for the Leyble Hub Capacitor Android app.
//
// Flow: launch the installed debug APK -> switch into the Capacitor WebView context ->
// fill + submit the login form -> assert the mandatory "Who's using this?" profile picker
// appears (proves the login POST succeeded) -> pick a profile -> assert the Dashboard
// heading renders underneath (proves the SPA fully reached its post-auth, post-first-sync
// state).
//
// See ../README.md for the full run sequence (emulator, backend, APK, Appium server).
// This is a manual/on-demand tool, not a CI gate — see CLAUDE.md and the README for why.

import { remote } from 'webdriverio';

const APPIUM_HOSTNAME = 'localhost';
const APPIUM_PORT = 4723;
const APPIUM_PATH = '/wd/hub';

const LOGIN_EMAIL = 'josie@leyblestore.com';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'leyble123';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}

async function main() {
  const driver = await remote({
    hostname: APPIUM_HOSTNAME,
    port: APPIUM_PORT,
    path: APPIUM_PATH,
    logLevel: 'warn',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': 'com.leyble.hub',
      'appium:appActivity': '.MainActivity',
      // The app must already be installed (see README step 3) — this test attaches to
      // it rather than installing/uninstalling, so a real device's app data isn't reset
      // out from under a human using the same device for manual QA.
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      // Chromedriver must match the on-device WebView's Chrome build almost exactly;
      // letting Appium fetch it avoids hand-pinning a version per device/emulator image.
      // Requires the server to be started with the matching --allow-insecure flag —
      // see README "Start the Appium server".
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': 180,
    },
  });

  try {
    // 1. Find and switch into the Capacitor WebView context. The native context
    //    (NATIVE_APP) is where the session starts; a Capacitor app's entire UI lives in
    //    one WebView, named WEBVIEW_<appPackage> once the page attaches.
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

    // 2. Fill in and submit the login form.
    const emailInput = await driver.$('input[type="email"]');
    await emailInput.waitForExist({ timeout: 20000 });
    await emailInput.setValue(LOGIN_EMAIL);

    const passwordInput = await driver.$('input[type="password"]');
    await passwordInput.setValue(LOGIN_PASSWORD);

    const signInButton = await driver.$("//button[contains(., 'Sign in')]");
    assert(await signInButton.isExisting(), 'found a "Sign in" button on the login screen');
    await signInButton.click();

    // 3. LoginPage navigates to /dashboard on success; ProfileGate (App.jsx) overlays the
    //    mandatory "Who's using this?" picker on top of it. Seeing this proves the login
    //    call succeeded and the SPA re-rendered into its authenticated state.
    const profilePickerHeading = await driver.$("//h2[contains(., \"Who's using this?\")]");
    await profilePickerHeading.waitForDisplayed({ timeout: 20000 });
    console.log('PASS: profile picker appeared after login (auth succeeded)');

    // 4. Pick the first profile -> picker dismisses -> Dashboard underneath is visible.
    //    Clicked via executeScript rather than a plain WebDriver click: the profile
    //    picker's flex layout combined with the app's forced sensorLandscape orientation
    //    was reporting "element not interactable" for a native click in testing.
    const clicked = await driver.execute(() => {
      const btn = document.evaluate(
        '//button[.//span[contains(@class, "rounded-full")]]',
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    assert(clicked === true, 'profile picker shows at least one profile button and it was clicked');

    // 5. First login on a freshly cleared device also passes through the app's one-time
    //    "Setting up this tablet" first-sync gate (products/customers/personnel) before
    //    the Dashboard renders — hence the generous timeout here versus step 3.
    const dashboardHeading = await driver.$("//h1[contains(., 'Dashboard')]");
    await dashboardHeading.waitForDisplayed({ timeout: 45000 });
    console.log('PASS: Dashboard heading visible after profile pick — login flow verified end to end');

    console.log('\nALL ASSERTIONS PASSED');
  } finally {
    await driver.deleteSession();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
