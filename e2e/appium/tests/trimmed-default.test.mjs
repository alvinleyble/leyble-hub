// The trimmed app every fresh install starts in: Settings' "Show everything" is off, so
// the tabs are Dashboard, Outgoing, Inventory and Customers; the menu holds Settings
// only; Outgoing stops at pending (no In Transit / Delivered / Closed); Inventory shows
// no stock counts; and a hidden screen's route lands on Outgoing. Turning the switch on
// brings it all back without a reinstall, and turning it off again trims it again.
//
// Run after `pm clear` like every other test here (the switch lives in the app's native
// storage, so a cleared app is a fresh, switched-off device).

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo, showEverything } from '../helpers/auth.js';
import { waitForTestId } from '../helpers/ui.js';

const exists = (driver, selector) => driver.execute((sel) => Boolean(document.querySelector(sel)), selector);
const testIdExists = (driver, id) => exists(driver, `[data-testid="${id}"]`);
const bodyText = (driver) => driver.execute(() => document.body.innerText);

async function assertTrimmed(driver) {
  for (const id of ['nav-link-dashboard', 'nav-link-orders', 'nav-link-inventory', 'nav-link-customers']) {
    assert(await testIdExists(driver, id), `${id} is on screen`);
  }
  for (const id of ['nav-link-incoming', 'nav-link-personnel', 'nav-link-tickets', 'nav-link-audit']) {
    assert(!(await testIdExists(driver, id)), `${id} is hidden`);
  }
  assert(await testIdExists(driver, 'nav-link-settings'), 'the menu still offers Settings');

  await navigateTo(driver, 'orders');
  await waitForTestId(driver, 'orders-list');
  for (const tab of ['all', 'draft', 'pending', 'cancelled']) {
    assert(await testIdExists(driver, `orders-tab-${tab}`), `Outgoing offers the ${tab} tab`);
  }
  for (const tab of ['in_transit', 'completed', 'done']) {
    assert(!(await testIdExists(driver, `orders-tab-${tab}`)), `Outgoing hides the ${tab} tab`);
  }

  await navigateTo(driver, 'inventory');
  await waitForTestId(driver, 'inventory-list');
  const text = await bodyText(driver);
  assert(!/In stock:|All stock|Low stock|Out of stock/.test(text), 'Inventory shows no stock counts or stock filter');
  assert(/₱/.test(text), 'Inventory still shows prices');
}

withSession(async (driver) => {
  await loginAs(driver);

  // 1. Default: off.
  await navigateTo(driver, 'settings');
  const toggle = await waitForTestId(driver, 'settings-show-everything');
  assert((await toggle.getAttribute('aria-checked')) === 'false', 'Show everything is off on a fresh install');
  assert((await (await waitForTestId(driver, 'settings-show-everything-state')).getText()) === 'Off',
    'the switch says Off in words');
  await assertTrimmed(driver);

  // 2. A hidden screen's route lands on Outgoing.
  await driver.execute(() => {
    window.history.pushState({}, '', '/tickets');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await driver.waitUntil(async () => (await driver.execute(() => window.location.pathname)) === '/orders',
    { timeout: 10000, interval: 500, timeoutMsg: 'the /tickets route did not land on Outgoing' });
  assert(true, 'typing the Tickets route lands on Outgoing');

  // 3. On: everything is back, no reinstall.
  await showEverything(driver);
  for (const id of ['nav-link-incoming', 'nav-link-personnel']) {
    assert(await testIdExists(driver, id), `${id} is back`);
  }
  await navigateTo(driver, 'orders');
  await waitForTestId(driver, 'orders-list');
  assert(await testIdExists(driver, 'orders-tab-in_transit'), 'In Transit is back on Outgoing');
  await navigateTo(driver, 'inventory');
  await waitForTestId(driver, 'inventory-list');
  assert(/All stock/.test(await bodyText(driver)), 'the stock filter is back on Inventory');

  // 4. Off again leaves the device as it started.
  await showEverything(driver, { on: false });
  await assertTrimmed(driver);

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
