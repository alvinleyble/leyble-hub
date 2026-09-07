// Personnel screen — basic coverage per e2e/appium/README.md "Adding a new test".

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, allTestId, assertCount, waitForCountSettled, setInputValue } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'personnel');

  // 1. The personnel list loads with real data.
  await waitForTestId(driver, 'personnel-list');
  await assertCount(driver, 'personnel-row', (n) => n > 0, 'Personnel list shows at least one person');

  // 2. The search control narrows the list.
  await setInputValue(driver, 'personnel-search-input', 'zzz-no-such-person-zzz');
  const narrowed = await waitForCountSettled(driver, 'personnel-row');
  assert(narrowed === 0, `search for a nonsense query narrows the personnel list to zero rows (got ${narrowed})`);
  await setInputValue(driver, 'personnel-search-input', '');
  await waitForCountSettled(driver, 'personnel-row');

  // 3. Opening an item from the list shows its detail view.
  const rows = await allTestId(driver, 'personnel-row');
  assert(rows.length > 0, `Personnel list has rows to open (found ${rows.length})`);
  await rows[0].click();

  await waitForTestId(driver, 'personnel-detail', { timeout: 20000 });
  assert(true, 'clicking a personnel row opened the personnel detail panel');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
