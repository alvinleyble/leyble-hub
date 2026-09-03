// Customers screen — basic coverage per e2e/appium/README.md "Adding a new test".

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, allTestId, assertCount, waitForCountSettled, setInputValue } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'customers');

  // 1. The customer list loads with real data.
  await waitForTestId(driver, 'customers-list');
  await assertCount(driver, 'customers-row', (n) => n > 0, 'Customers list shows at least one customer');

  // 2. The search control narrows the list.
  await setInputValue(driver, 'customers-search-input', 'zzz-no-such-customer-zzz');
  const narrowed = await waitForCountSettled(driver, 'customers-row');
  assert(narrowed === 0, `search for a nonsense query narrows the customers list to zero rows (got ${narrowed})`);
  await setInputValue(driver, 'customers-search-input', '');
  await waitForCountSettled(driver, 'customers-row');

  // 3. Opening an item from the list shows its detail view.
  const rows = await allTestId(driver, 'customers-row');
  assert(rows.length > 0, `Customers list has rows to open (found ${rows.length})`);
  await rows[0].click();

  await waitForTestId(driver, 'customer-detail', { timeout: 20000 });
  assert(true, 'clicking a customer row opened the customer detail panel');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
