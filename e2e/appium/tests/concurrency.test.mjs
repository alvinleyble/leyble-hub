// ADR 0019 stale-write coverage. This test requires TWO booted Android devices/emulators
// with the staging debug APK installed and one Appium server running. Set DEVICE_A_UDID
// and DEVICE_B_UDID to target them; the defaults are the standard two local emulators.

import { createDriver, switchToWebview, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import {
  allTestId, clickTestId, setInputValue, testId, waitForCountSettled, waitForTestId,
} from '../helpers/ui.js';

const DEVICE_A_UDID = process.env.DEVICE_A_UDID || 'emulator-5554';
const DEVICE_B_UDID = process.env.DEVICE_B_UDID || 'emulator-5556';

// ADR 0017 allows only one active session per account. Use separate remembered accounts
// for the concurrent writers; overrides are useful if a staging fixture has different ones.
const DEVICE_A_EMAIL = process.env.DEVICE_A_EMAIL || 'josie@leyblestore.com';
const DEVICE_B_EMAIL = process.env.DEVICE_B_EMAIL || 'luis@leyblestore.com';

async function openFirstNonDraftOrder(driver) {
  await waitForTestId(driver, 'orders-list');

  // The shared dev database has no fixture guaranteed to remain Pending, so both devices
  // choose the first visible row from the first non-draft status that has one. No write
  // happens until BOTH detail pages are open, so their deterministic status/list ordering
  // identifies the same order; the receipt heading below verifies that assumption.
  for (const status of ['pending', 'in_transit', 'completed', 'done', 'cancelled']) {
    await clickTestId(driver, `orders-tab-${status}`);
    await waitForCountSettled(driver, 'orders-row');
    const rows = await allTestId(driver, 'orders-row');
    if (rows.length === 0) continue;

    await driver.execute((el) => el.click(), rows[0]);
    await waitForTestId(driver, 'order-detail');
    const heading = await driver.$(`${testId('order-detail')} h1`);
    await heading.waitForDisplayed({ timeout: 20000 });
    return heading.getText();
  }

  throw new Error('No non-draft order is available in the staging/dev database. Create one before retrying.');
}

// A plain WebDriver `.isExisting()` read against this app was seen to report a false
// "gone" during the React unmount transition at least once during earlier debugging, so
// this requires the absence to hold for two consecutive polls (not just one instant) via
// a direct document.querySelector rather than a cached WebDriver element handle. On
// timeout it logs the modal's current outerHTML so a real hang is distinguishable from a
// detection bug without re-running under a debugger.
async function waitForEditToClose(driver, { label = '' } = {}) {
  let consecutiveAbsent = 0;
  try {
    await driver.waitUntil(
      async () => {
        const exists = await driver.execute(
          (sel) => Boolean(document.querySelector(sel)),
          testId('order-edit-save')
        );
        consecutiveAbsent = exists ? 0 : consecutiveAbsent + 1;
        return consecutiveAbsent >= 2;
      },
      { timeout: 30000, interval: 500, timeoutMsg: 'the order edit modal did not close after saving' }
    );
  } catch (err) {
    const html = await driver.execute((sel) => {
      const node = document.querySelector(sel);
      return node ? node.outerHTML.slice(0, 500) : '(element not found, but wait still failed)';
    }, testId('order-edit-save')).catch(() => '(could not read DOM)');
    console.error(`waitForEditToClose(${label}) timed out. order-edit-save DOM snapshot:`, html);
    throw err;
  }
}

// The order-edit notes input sits inside the mobile bottom cart sheet (same
// `OrderCreateModal.jsx` component as order creation — see its "View cart"/"Hide cart"
// toggle), collapsed by default at phone/tablet width. Expand it before waiting for
// `order-edit-notes-input`, or the wait times out against an input that's off-screen.
async function ensureCartSheetOpen(driver) {
  try {
    const notesInput = await driver.$(testId('order-edit-notes-input'));
    if (await notesInput.isDisplayed()) return;
  } catch {}

  try {
    const viewCartBtn = await driver.$("//button[contains(., 'View cart')]");
    await viewCartBtn.waitForDisplayed({ timeout: 10000 });
    await driver.execute((el) => el.click(), viewCartBtn);
  } catch {}
}

// Login, navigate to Orders, open the shared order and its edit form — everything up
// to (but not including) the actual write. Run this per device SEQUENTIALLY rather than
// via Promise.all: none of it needs to happen at the same instant as the other device's
// equivalent steps (only the write ordering at the end matters for ADR 0019 — B's edit
// form must be open, with its revision captured, before A's save lands). Running it
// concurrently was observed to crash the on-device UiAutomator2 instrumentation
// (MjpegScreenshotServer) on a loaded host running two emulators against the real
// (higher-latency) shared dev/test DB — pure resource contention, not an app or test
// logic issue, and this sidesteps it by halving the simultaneous automation load.
async function setUpDeviceToEditForm(driver, email) {
  await loginAs(driver, { email });
  await navigateTo(driver, 'orders');
  const orderHeading = await openFirstNonDraftOrder(driver);
  await clickTestId(driver, 'order-edit-button');
  await ensureCartSheetOpen(driver);
  await waitForTestId(driver, 'order-edit-notes-input');
  return orderHeading;
}

async function run() {
  const sessions = await Promise.allSettled([
    createDriver({ udid: DEVICE_A_UDID }),
    createDriver({ udid: DEVICE_B_UDID }),
  ]);
  const drivers = sessions.filter((result) => result.status === 'fulfilled').map((result) => result.value);

  try {
    const failed = sessions.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;

    const [driverA, driverB] = drivers;
    await Promise.all([switchToWebview(driverA), switchToWebview(driverB)]);

    const orderA = await setUpDeviceToEditForm(driverA, DEVICE_A_EMAIL);
    const orderB = await setUpDeviceToEditForm(driverB, DEVICE_B_EMAIL);
    assert(orderA === orderB, `both devices opened the same non-draft order (${orderA})`);

    // Notes are the least disruptive write: this advances the revision without changing
    // stock, fulfillment status, quantities, or the bottle-return ledger.
    await setInputValue(driverA, 'order-edit-notes-input', `ADR 0019 Appium A ${Date.now()}`);
    await clickTestId(driverA, 'order-edit-save');
    await waitForEditToClose(driverA, { label: 'driverA' });
    assert(true, 'session A saved its note change and advanced the order revision');

    await setInputValue(driverB, 'order-edit-notes-input', `ADR 0019 Appium B ${Date.now()}`);
    await clickTestId(driverB, 'order-edit-save');

    const conflict = await waitForTestId(driverB, 'toast-error', { timeout: 20000 });
    const conflictText = await conflict.getText();
    assert(
      /changed on another device/.test(conflictText) && /Your change was not saved/.test(conflictText),
      `session B received the ADR 0019 stale-write message: ${conflictText}`
    );

    console.log('\nALL ASSERTIONS PASSED');
  } finally {
    await Promise.all(drivers.map((driver) => driver.deleteSession().catch(() => {})));
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
