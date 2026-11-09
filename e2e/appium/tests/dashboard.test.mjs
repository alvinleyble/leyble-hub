// Dashboard screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// The Dashboard is sales and products (captain's grill, 2026-11-09), in three sub-tabs
// (2026-11-10): Sales (the three gross-sales totals, a day-by-day chart for the month,
// the by-month trend), Products (the top 10 products and the slow movers) and Stock
// (low stock). It has no filter/search control and no item opens a detail view, so
// the closest equivalents are checked instead: the figures load, tapping a day's bar
// reads that day out above the chart, and each tab shows its own panel.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs } from '../helpers/auth.js';
import { waitForTestId, allTestId, clickTestId } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);

  // The device remembers the last tab used, so start from Sales explicitly.
  await clickTestId(driver, 'dashboard-tab-sales');

  // 1. The three gross-sales totals load, each with a peso figure.
  for (const id of ['dashboard-total-today', 'dashboard-total-week', 'dashboard-total-month']) {
    const tile = await waitForTestId(driver, id);
    const text = await tile.getText();
    assert(/₱[\d,]+\.\d{2}/.test(text), `${id} shows a peso total (got "${text}")`);
  }

  // 2. The day-by-day chart has one bar per day of the month so far.
  await waitForTestId(driver, 'dashboard-daily');
  const bars = await allTestId(driver, 'dashboard-daily-bar');
  assert(bars.length > 0, `Dashboard chart shows at least one day (found ${bars.length})`);

  // 3. Tapping the first day's bar reads that day out above the chart.
  // A JS click, as clickTestId does — a thin bar can report "not interactable" natively.
  await driver.execute((el) => el.click(), bars[0]);
  const selected = await waitForTestId(driver, 'dashboard-daily-selected');
  const readout = await selected.getText();
  assert(/₱[\d,]+\.\d{2}/.test(readout), `tapping a bar shows that day's total (got "${readout}")`);

  // 4. Products: its own month pager over the top 10 and the slow movers.
  await clickTestId(driver, 'dashboard-tab-products');
  const month = await waitForTestId(driver, 'dashboard-products-month-label');
  const monthText = await month.getText();
  assert(/^[A-Z][a-z]+ \d{4}$/.test(monthText), `Products names its month (got "${monthText}")`);

  // 5. Stock: the low-stock panel.
  await clickTestId(driver, 'dashboard-tab-stock');
  const stock = await waitForTestId(driver, 'dashboard-low-stock');
  assert(/Low Stock/.test(await stock.getText()), 'Stock shows the low-stock panel');

  // Leave the device on Sales, the default, for whatever runs next.
  await clickTestId(driver, 'dashboard-tab-sales');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
