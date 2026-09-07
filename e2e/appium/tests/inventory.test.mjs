// Inventory screen — basic coverage per e2e/appium/README.md "Adding a new test".

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, allTestId, assertCount, waitForCountSettled, setInputValue } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'inventory');

  // 1. The product list loads with real data.
  await waitForTestId(driver, 'inventory-list');
  await assertCount(driver, 'inventory-row', (n) => n > 0, 'Inventory list shows at least one product');

  // 2. The search control narrows the list.
  await setInputValue(driver, 'inventory-search-input', 'zzz-no-such-product-zzz');
  const narrowed = await waitForCountSettled(driver, 'inventory-row');
  assert(narrowed === 0, `search for a nonsense query narrows the inventory list to zero rows (got ${narrowed})`);
  await setInputValue(driver, 'inventory-search-input', '');
  await waitForCountSettled(driver, 'inventory-row');

  // 3. Opening an item from the list shows its detail view.
  const rows = await allTestId(driver, 'inventory-row');
  assert(rows.length > 0, `Inventory list has rows to open (found ${rows.length})`);
  await rows[0].click();

  await waitForTestId(driver, 'product-detail', { timeout: 20000 });
  assert(true, 'clicking a product row opened the product detail panel');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
