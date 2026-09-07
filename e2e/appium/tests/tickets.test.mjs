// Tickets screen — basic coverage per e2e/appium/README.md "Adding a new test".
//
// Tickets has no free-text search — the status filter (Pending / Resolved / All) is its
// closest equivalent, per the task brief's allowance for screens without a search box.

import { withSession, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { waitForTestId, clickTestId, allTestId, waitForCountSettled } from '../helpers/ui.js';

withSession(async (driver) => {
  await loginAs(driver);
  await navigateTo(driver, 'tickets');

  // 1. The ticket list loads with real data. "All" is used for this check (rather than
  // the default "Pending" tab) since it is the tab virtually certain to be non-empty.
  await waitForTestId(driver, 'tickets-list');
  await clickTestId(driver, 'tickets-filter-all');
  const allCount = await waitForCountSettled(driver, 'tickets-row');
  assert(allCount > 0, `Tickets "All" tab shows at least one ticket (found ${allCount})`);

  // 2. The status filter narrows the list — every visible row's status badge must
  // actually read "Pending" once that filter is selected, not just fewer rows by chance.
  await clickTestId(driver, 'tickets-filter-pending');
  await waitForCountSettled(driver, 'tickets-row');
  const badges = await allTestId(driver, 'tickets-status-badge');
  assert(badges.length <= allCount, `"Pending" filter shows no more rows than "All" (${badges.length} <= ${allCount})`);
  for (const badge of badges) {
    const text = (await badge.getText()).trim();
    assert(text === 'Pending', `ticket row status badge reads "Pending" under the Pending filter (got "${text}")`);
  }

  // 3. Opening an item from the list shows its detail view.
  const rows = await allTestId(driver, 'tickets-row');
  assert(rows.length > 0, `Tickets "Pending" tab has rows to open (found ${rows.length})`);
  await rows[0].click();

  await waitForTestId(driver, 'ticket-detail', { timeout: 20000 });
  assert(true, 'clicking a ticket row opened the ticket detail panel');

  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
