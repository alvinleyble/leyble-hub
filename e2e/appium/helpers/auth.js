// Shared login + navigation helpers. Every screen test needs to start from an
// authenticated state on /dashboard, then reach its own screen through the top tabs —
// this is that flow, factored out of login.test.mjs so it isn't repeated in each test.

import { assert } from './driver.js';
import { clickTestId } from './ui.js';

// ADR 0017 §5/§6 — every person has their own account now, so there is no shared login
// and no profile pick. Pass `email` to drive the suite as Alvin or Luis instead; all
// three accounts share the same password by captain decision.
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'josie@leyblestore.com';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'leyble123';

// Logs in and waits for the Dashboard to render — the same flow login.test.mjs
// originally drove inline (see its history for the full rationale of each step, e.g. why
// the first-run "Setting up this tablet" sync gate needs a generous timeout).
export async function loginAs(driver, { email = LOGIN_EMAIL, password = LOGIN_PASSWORD } = {}) {
  const emailInput = await driver.$('input[type="email"]');
  if (await emailInput.isExisting()) {
    await emailInput.setValue(email);

    const passwordInput = await driver.$('input[type="password"]');
    await passwordInput.setValue(password);

    const signInButton = await driver.$("//button[contains(., 'Sign in')]");
    assert(await signInButton.isExisting(), 'found a "Sign in" button on the login screen');
    await signInButton.click();
  } else {
    // Already authenticated (e.g. a prior test in the same session left the app on
    // another screen) — nudge back to Dashboard instead of failing to find a login form.
    const isDashboard = await (await driver.$("//h1[contains(., 'Dashboard')]")).isDisplayed().catch(() => false);
    if (!isDashboard) {
      const dashboardTab = await driver.$('[data-testid="nav-link-dashboard"]');
      if (await dashboardTab.isExisting()) {
        await navigateTo(driver, 'dashboard');
      }
    }
  }

  // The Dashboard is now the first thing after a successful sign-in — nothing sits
  // between the login POST and the app shell. The generous timeout is the first-run
  // "Setting up this tablet" sync gate, which can still hold the app briefly. The
  // 2s poll interval (vs. webdriverio's 500ms default) matters on a loaded host: a
  // tight poll here was observed to crash the on-device UiAutomator2 instrumentation
  // (MjpegScreenshotServer) under a two-emulator + remote-DB-latency run, taking the
  // whole session down mid-login — not an app bug, just too many automation calls per
  // second against an already resource-starved instrumentation process.
  await driver.waitUntil(
    async () => {
      try {
        const dashboardHeading = await driver.$("//h1[contains(., 'Dashboard')]");
        return await dashboardHeading.isDisplayed();
      } catch {
        return false;
      }
    },
    { timeout: 60000, interval: 2000, timeoutMsg: `Dashboard heading still not displayed after signing in as ${email}` }
  );
  assert(true, `Dashboard heading visible after signing in as ${email} — login flow verified end to end`);
}

// ADR 0017 #7 — the two-tap switch between accounts this device already remembers. No
// password, no server round trip: this is the flow that has to work mid-blackout when one
// person hands the tablet to another, and it is what replaced the profile picker slice 3
// deleted.
//
// Only works for an account that has ALREADY signed in successfully on this device (a
// person's first sign-in still needs a connection — ADR 0015 §2), so drive `loginAs` for
// each account once before calling this. `pm clear` wipes the list; see the README.
export async function switchAccount(driver, email) {
  // The switcher lives in Settings now: menu → Settings → Switch account → the account.
  await navigateTo(driver, 'settings');
  await clickTestId(driver, 'account-switcher-button');
  assert(true, 'opened the account switcher from Settings');

  await clickTestId(driver, `account-switch-${email}`);
  assert(true, `switched this tablet to ${email} with no password`);
}

// The six top tabs are always on screen; everything else sits behind the hamburger
// menu at the far right of the tab bar (client/src/components/layout/navigation.js).
const MENU_PATHS = new Set(['tickets', 'audit', 'settings']);

// Taps the given screen's tab, or opens the menu first for a screen that lives there.
// `navPath` is the route without its leading slash, e.g. 'orders', 'inventory', 'audit'.
export async function navigateTo(driver, navPath) {
  if (MENU_PATHS.has(navPath)) await clickTestId(driver, 'nav-menu-button');
  await clickTestId(driver, `nav-link-${navPath}`);
}
