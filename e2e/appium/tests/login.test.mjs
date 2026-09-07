// Appium proof-of-concept / reusable login test for the Leyble Hub Capacitor Android app.
//
// Flow: launch the installed debug APK -> switch into the Capacitor WebView context ->
// fill + submit the login form with one person's own account -> assert the Dashboard
// heading renders (proves both that the login POST succeeded and that the SPA reached its
// post-auth, post-first-sync state). The flow itself lives in ../helpers/auth.js's
// loginAs() so every other screen test can start from the same authenticated state
// without repeating it.
//
// The "Who's using this?" profile picker this used to assert on is gone — ADR 0017 §5
// gave each person their own login and deleted profiles as a concept.
//
// See ../README.md for the full run sequence (emulator, backend, APK, Appium server).
// This is a manual/on-device tool, not a CI gate — see CLAUDE.md and the README for why.

import { withSession } from '../helpers/driver.js';
import { loginAs } from '../helpers/auth.js';

withSession(async (driver) => {
  await loginAs(driver);
  console.log('\nALL ASSERTIONS PASSED');
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
