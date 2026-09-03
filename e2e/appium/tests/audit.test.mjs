// Audit Log screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// Audit Log is read-only (CLAUDE.md's module table) — an inventory-tab row has no click
// handler and opens nothing. The closest equivalent to "opening an item's detail view" is
// the Activity tab's order reference link, which always navigates to that order's real
// detail view. This substitution is called out here and in the PR description, matching
// the task brief's allowance for a screen without a literal match to a required check.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, clickTestId, allTestId, assertCount, waitForCountSettled } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'audit');

  // 1. The Inventory tab's list loads with real data (default tab).
  await waitForTestId(driver, 'audit-list');
  await assertCount(driver, 'audit-row', (n) => n > 0, 'Audit Log (Inventory tab) shows at least one entry');

  // 2. The action-type filter narrows the list — every visible row's action badge must
  // read "Restock" once that filter is selected. Restock entries come from Incoming
  // Supplies' auto-restock, a long-shipped, actively-used module (CLAUDE.md), so this is
  // the action type most likely to be non-empty in any dev/QA database.
  const actionFilter = await waitForTestId(driver, 'audit-filter-action');
  await actionFilter.selectByAttribute('value', 'restock');
  await waitForCountSettled(driver, 'audit-row');
  const badges = await allTestId(driver, 'audit-action-badge');
  assert(badges.length > 0, `"Restock" filter narrows the Audit Log to at least one entry (found ${badges.length})`);
  for (const badge of badges) {
    const text = (await badge.getText()).trim();
    assert(text === 'Restock', `audit row action badge reads "Restock" under the Restock filter (got "${text}")`);
  }

  // 3. Opening an item from the list shows its detail view (via the Activity tab's order
  // reference link — see file header for why this is the closest equivalent here).
  await clickTestId(driver, 'audit-tab-activity');
  await waitForTestId(driver, 'audit-list');
  const entityFilter = await waitForTestId(driver, 'audit-filter-entity');
  await entityFilter.selectByAttribute('value', 'order');
  await waitForCountSettled(driver, 'audit-row');

  const orderLinks = await allTestId(driver, 'audit-order-ref-link');
  assert(orderLinks.length > 0, `Activity tab filtered to "Order" shows at least one order reference (found ${orderLinks.length})`);
  await orderLinks[0].click();

  await waitForTestId(driver, 'order-detail', { timeout: 20000 });
  assert(true, 'clicking an audit activity order reference opened the order detail view');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
