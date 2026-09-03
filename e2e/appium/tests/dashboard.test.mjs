// Dashboard screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// Dashboard has no filter/search control and no closer equivalent (no tabs, no category
// switch — the Active Orders table and Low Stock panel both render unconditionally, at
// once, not behind a toggle). Per the task brief this is noted here rather than forced:
// only checks 1 and 3 apply to this screen.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs } from '../helpers/auth.js';
import { waitForTestId, allTestId } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);

  // 1. The Active Orders list loads with real data.
  await waitForTestId(driver, 'dashboard-orders-list');
  const rows = await allTestId(driver, 'dashboard-order-row');
  assert(rows.length > 0, `Dashboard Active Orders table shows at least one order (found ${rows.length})`);

  // 3. Opening an item from the list shows its detail view (Order Detail).
  const link = await rows[0].$('a');
  assert(await link.isExisting(), 'first Active Orders row has a receipt link');
  await link.click();

  await waitForTestId(driver, 'order-detail', { timeout: 20000 });
  assert(true, 'clicking a Dashboard order row opened the order detail view');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
