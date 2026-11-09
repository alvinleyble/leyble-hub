// Dashboard screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// The Dashboard is sales and products (captain's grill, 2026-11-09): three gross-sales
// totals, a day-by-day chart for the month, the top 10 products and the slow movers.
// It has no filter/search control and no item opens a detail view, so the closest
// equivalents are checked instead: the figures load, and tapping a day's bar reads that
// day out above the chart.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs } from '../helpers/auth.js';
import { waitForTestId, allTestId } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);

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

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
