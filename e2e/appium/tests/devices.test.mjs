// Devices screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// Devices (StationsPage.jsx) has no search, filter, tab, or category switch of any kind —
// it's a fixed-content management screen: "This tablet", the three receipt-number slots,
// and unassigned devices all render simultaneously, never behind a toggle. Per the task
// brief this is noted here (and in the PR description) rather than forced: check 2 does
// not apply to this screen.
//
// For check 3, clicking "Use this tablet" on a slot is the closest equivalent to opening
// a detail view: it surfaces information not on the list row (the next receipt number
// this slot would issue, and — when replacing a device — a warning about unsynced
// orders) in a confirm dialog. The test opens that dialog and then cancels out of it
// without confirming, since confirming would actually reassign a receipt-number slot in
// the shared dev database.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, allTestId } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'devices');

  // 1. The slots list loads with real data — always exactly three fixed slots.
  await waitForTestId(driver, 'devices-slots-list');
  const slotItems = await allTestId(driver, 'devices-slot-item');
  assert(slotItems.length === 3, `Devices screen shows all three fixed receipt-number slots (found ${slotItems.length})`);

  // 3. Opening an item surfaces its detail (see file header for why "Use this tablet" is
  // the closest equivalent to a detail view on this screen).
  const assignButtons = await allTestId(driver, 'devices-slot-assign-button');
  assert(assignButtons.length > 0, `at least one slot offers "Use this tablet" (found ${assignButtons.length})`);
  await assignButtons[0].click();

  await waitForTestId(driver, 'devices-assign-modal', { timeout: 10000 });
  assert(true, 'clicking "Use this tablet" opened the slot assignment detail dialog');

  // Cancel rather than confirm — confirming would really reassign a receipt-number slot.
  const cancelButton = await driver.$("//button[contains(., 'Cancel')]");
  assert(await cancelButton.isExisting(), 'assignment dialog has a Cancel button');
  await cancelButton.click();

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
