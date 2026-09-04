// Shared login + navigation helpers. Every screen test needs to start from an
// authenticated state on /dashboard, then reach its own screen through the nav drawer —
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
  await emailInput.waitForExist({ timeout: 20000 });
  await emailInput.setValue(email);

  const passwordInput = await driver.$('input[type="password"]');
  await passwordInput.setValue(password);

  const signInButton = await driver.$("//button[contains(., 'Sign in')]");
  assert(await signInButton.isExisting(), 'found a "Sign in" button on the login screen');
  await signInButton.click();

  // The Dashboard is now the first thing after a successful sign-in — nothing sits
  // between the login POST and the app shell. The generous timeout is the first-run
  // "Setting up this tablet" sync gate, which can still hold the app briefly.
  const dashboardHeading = await driver.$("//h1[contains(., 'Dashboard')]");
  await dashboardHeading.waitForDisplayed({ timeout: 45000 });
  assert(true, `Dashboard heading visible after signing in as ${email} — login flow verified end to end`);
}

// Opens the slide-in nav drawer (today's tablet layout — the emulator this suite runs
// against renders below the `desktop:` breakpoint, see client/src/components/layout/
// AppLayout.jsx) and taps the given screen's link. `navPath` is the route without its
// leading slash, e.g. 'orders', 'inventory', 'devices'.
//
// AppLayout mounts <Sidebar> twice — once for the permanent desktop rail (kept in the
// DOM but `display:none` below the `desktop:` breakpoint), once for this drawer — so
// every `nav-link-*` testid exists twice. A plain querySelector grabs whichever comes
// first in DOM order (the permanently-hidden desktop copy), which is never clickable on
// this layout, so this picks the copy that's actually laid out (non-zero size) instead.
export async function navigateTo(driver, navPath) {
  await clickTestId(driver, 'nav-menu-button');
  const clicked = await driver.execute((selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const visible = nodes.find((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0);
    if (visible) { visible.click(); return true; }
    return false;
  }, `[data-testid="nav-link-${navPath}"]`);
  assert(clicked === true, `clicked the visible nav-link-${navPath}`);
}
