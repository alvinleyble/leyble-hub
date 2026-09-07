// Outgoing Orders screen — basic coverage per e2e/appium/README.md "Adding a new test".

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, clickTestId, allTestId, assertCount, waitForCountSettled, setInputValue } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'orders');

  // 1. The order list loads with real data (default "All" tab).
  await waitForTestId(driver, 'orders-list');
  await assertCount(driver, 'orders-row', (n) => n > 0, 'Orders list shows at least one order');

  // 2. The search control narrows the list — a query matching nothing collapses it to
  // zero rows, which proves the filter is wired up regardless of what's actually seeded.
  await setInputValue(driver, 'orders-search-input', 'zzz-no-such-order-zzz');
  const narrowed = await waitForCountSettled(driver, 'orders-row');
  assert(narrowed === 0, `search for a nonsense query narrows the orders list to zero rows (got ${narrowed})`);
  await setInputValue(driver, 'orders-search-input', '');
  await waitForCountSettled(driver, 'orders-row');

  // 3. Opening an item from the list shows its detail view. Any non-"draft" tab is used
  // (rather than "All") so the first row is guaranteed to navigate to Order Detail —
  // clicking a Draft row instead opens the resume-draft modal, not the detail page. Which
  // status actually has rows varies with the shared dev database's contents, so this
  // tries each in turn rather than assuming "Pending" specifically is non-empty.
  let detailRows = [];
  for (const tab of ['pending', 'in_transit', 'completed', 'done', 'cancelled']) {
    await clickTestId(driver, `orders-tab-${tab}`);
    await waitForCountSettled(driver, 'orders-row');
    detailRows = await allTestId(driver, 'orders-row');
    if (detailRows.length > 0) break;
  }
  assert(detailRows.length > 0, `at least one non-draft Orders tab has a row to open (found ${detailRows.length})`);
  await detailRows[0].click();

  await waitForTestId(driver, 'order-detail', { timeout: 20000 });
  assert(true, 'clicking a non-draft order row opened the order detail view');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
