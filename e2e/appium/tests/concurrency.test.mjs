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

    await rows[0].click();
    await waitForTestId(driver, 'order-detail');
    const heading = await driver.$(`${testId('order-detail')} h1`);
    await heading.waitForDisplayed({ timeout: 20000 });
    return heading.getText();
  }

  throw new Error('No non-draft order is available in the staging/dev database. Create one before retrying.');
}

async function waitForEditToClose(driver) {
  await driver.waitUntil(
    async () => !(await driver.$(testId('order-edit-save'))).isExisting(),
    { timeout: 20000, timeoutMsg: 'the order edit modal did not close after saving' }
  );
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
    await Promise.all([
      loginAs(driverA, { email: DEVICE_A_EMAIL }),
      loginAs(driverB, { email: DEVICE_B_EMAIL }),
    ]);
    await Promise.all([navigateTo(driverA, 'orders'), navigateTo(driverB, 'orders')]);

    const [orderA, orderB] = await Promise.all([
      openFirstNonDraftOrder(driverA),
      openFirstNonDraftOrder(driverB),
    ]);
    assert(orderA === orderB, `both devices opened the same non-draft order (${orderA})`);

    await Promise.all([
      clickTestId(driverA, 'order-edit-button'),
      clickTestId(driverB, 'order-edit-button'),
    ]);
    await Promise.all([
      waitForTestId(driverA, 'order-edit-notes-input'),
      waitForTestId(driverB, 'order-edit-notes-input'),
    ]);

    // Notes are the least disruptive write: this advances the revision without changing
    // stock, fulfillment status, quantities, or the bottle-return ledger.
    await setInputValue(driverA, 'order-edit-notes-input', `ADR 0019 Appium A ${Date.now()}`);
    await clickTestId(driverA, 'order-edit-save');
    await waitForEditToClose(driverA);
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
