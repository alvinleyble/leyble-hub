# Appium on-device UI tests

Scripted taps/typing against the real Leyble Hub Android app (Capacitor-wrapped React) on a
booted emulator or device — for exercising real device/WebView behavior and actual on-screen
state that the JVM/unit test suites (`server/`, `client/test/`, `audit-client.test.mjs`) can't
reach. This is a **manual/on-demand tool, not a CI gate** — see "Why this isn't in CI" below.

## What's here

- `tests/login.test.mjs` — log in with one person's own account and confirm the Dashboard
  renders. (There is no profile picker any more — ADR 0017 §5 deleted it; the Dashboard is
  the first thing after a successful sign-in.)
  Since ADR 0017 #7 the login screen ALSO lists the accounts this device has already signed
  in successfully, above the email/password form — tapping one switches to it with no
  password and no server round trip, which is what has to work during a blackout. The form
  is unchanged and still the only way a NEW account reaches a device, so `loginAs` drives it
  exactly as before.
- `tests/dashboard.test.mjs`, `orders.test.mjs`, `inventory.test.mjs`, `customers.test.mjs`,
  `personnel.test.mjs`, `tickets.test.mjs`, `audit.test.mjs` — one basic
  test per core screen: its list loads with real data, a filter/search control narrows it (or
  the screen's closest equivalent — see each file's header comment for screens where none
  applies or a substitution was made), and opening an item shows its detail view. Use any of
  these as the template for a new test.
- `helpers/driver.js` — connects to Appium, switches into the Capacitor WebView context, and
  `withSession(fn)` wraps both plus session teardown around a test body.
- `helpers/auth.js` — `loginAs(driver)` (the login flow every test starts from; defaults to
  `josie@leyblestore.com`, pass `{ email }` to drive the suite as Alvin or Luis — all three
  accounts share the same password),
  `switchAccount(driver, email)` (ADR 0017 #7 — the two-tap, no-password switch between
  accounts this device already remembers) and
  `navigateTo(driver, 'orders')` (opens the nav drawer and taps a screen's link — see "How
  screen tests navigate" below).
- `helpers/ui.js` — small `data-testid`-based query/click helpers (`waitForTestId`,
  `clickTestId`, `allTestId`, `assertCount`, `waitForCountSettled`) used across every test.
- `package.json` — `appium` (the WebDriver-protocol server), `appium-uiautomator2-driver` (the
  Android driver), `webdriverio` (the client library the tests are written against).

## `data-testid` hooks

Every screen's list container, filter/search control, list item, and detail-view root carry a
`data-testid` (e.g. `orders-list`, `orders-search-input`, `orders-row`, `order-detail`) so tests
don't depend on visible copy or DOM structure — grep the relevant `client/src/pages/**` file for
`data-testid` to see a screen's hooks. Navigation carries them too: `nav-menu-button` (the
hamburger) and `nav-link-<path>` (e.g. `nav-link-orders`) on each drawer link.

Nothing here touches `client/` or `server/`'s own build or test setup. The one thing it does
depend on outside this directory is a debug-build-only Android networking override — see
"How the debug build reaches your local backend" below.

## One-time setup

1. Android Studio installed (bundles the JDK + Android SDK Gradle needs) and at least one AVD
   created. This repo was scouted/shipped against `Medium_Phone` (API 37, `google_apis_playstore`,
   arm64-v8a) — any recent AVD should work the same way.
2. `cd e2e/appium && npm install`. This also pulls in the `uiautomator2` Appium driver as a
   dependency; `npx appium driver list --installed` should show `uiautomator2` without needing
   a separate `appium driver install` step.
3. In `server/.env`, make sure `DEV_CORS_EXTRA_ORIGINS` includes `http://localhost` (comma-
   separated, alongside whatever else is already there). The debug build's WebView origin is
   `http://localhost` (see below) and the API's CORS allow-list needs to recognize it —
   `server/src/index.js`'s allow-list already covers the production Capacitor origins
   (`https://localhost`, `capacitor://localhost`); this is the one addition needed for local
   testing.

## Running a test

```bash
# 1. Boot the emulator headed (visible), matching this fleet's on-device QA convention —
#    NOT -no-window.
~/Library/Android/sdk/emulator/emulator -avd Medium_Phone -no-snapshot -gpu swiftshader_indirect
# wait for it to finish booting:
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

# 2. Start the backend, pointed at the dev database as usual.
cd server && node src/index.js

# 3. Build and install the debug APK (picks up the debug-only networking override
#    automatically — see below).
cd client && npm run android:sync   # vite build && cap sync android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 4. Start the Appium server. The --allow-insecure flag is REQUIRED — without it, switching
#    into the app's WebView fails with "No Chromedriver found that can automate Chrome
#    '<version>'" even though appium:chromedriverAutodownload is set in the test's
#    capabilities. Appium 3's insecure-feature gate needs the flag scoped to the driver name
#    (uiautomator2:...) — a bare --allow-insecure chromedriver_autodownload is rejected at
#    server boot.
cd e2e/appium
npx appium --base-path /wd/hub --allow-insecure uiautomator2:chromedriver_autodownload

# 5. In another terminal: clear the app's persisted login (see "Clean state" below), then run
#    a test — any of the `test:*` scripts in package.json (test:login, test:dashboard,
#    test:orders, test:inventory, test:customers, test:personnel, test:tickets,
#    test:audit). Every non-login test logs in for itself first (helpers/auth.js), so
#    `pm clear` before each of them matters the same way it does for test:login.
adb shell am force-stop com.leyble.hub
adb shell pm clear com.leyble.hub
cd e2e/appium
npm run test:login
```

Expected output:

```
Found webview context: WEBVIEW_com.leyble.hub
PASS: found a "Sign in" button on the login screen
PASS: Dashboard heading visible after signing in as josie@leyblestore.com — login flow verified end to end

ALL ASSERTIONS PASSED
```

### Clean state matters

`login.test.mjs` uses `appium:noReset: true` (so it attaches to the app you installed rather
than reinstalling/wiping it on every run — useful if you're also poking at the device by hand).
That means a **successful login persists** across runs: the JWT lives in
`@capacitor/preferences`, which survives `am force-stop`. Re-running without `pm clear` lands
directly on `/dashboard` and the test's login-form selectors report "no such element" because
there's no login form to find. Always `pm clear com.leyble.hub` before a login-flow run.

`pm clear` also wipes the remembered-accounts list (ADR 0017 #7) and every device letter the
app holds, since all of it lives in the same `@capacitor/preferences` store. That is what you
want before a login-flow run, and it is the thing to remember when testing the switcher: a
cleared device remembers nobody, so each account you want to switch between has to sign in
once, with the backend reachable, before the two-tap switch exists at all.

## How the debug build reaches your local backend

Two independent Android rules would otherwise block a debug APK from talking to a backend on
your own machine (`http://10.0.2.2:<port>`, the emulator's host-loopback alias):

1. **Cleartext (plain HTTP) is blocked by default** above API 28 (`targetSdkVersion` here is
   36) unless a network security config says otherwise.
2. **Mixed content is blocked independently of (1).** Capacitor's `androidScheme: "https"`
   (`client/capacitor.config.json`) makes the production app's WebView load its own pages from
   `https://localhost`; a page loaded over HTTPS fetching plain `http://` is blocked by
   Chrome/WebView itself, separate from the Android-level cleartext rule.

The fix is scoped to the **debug build variant only**, via Android's standard source-set
override mechanism — Gradle merges `src/debug/*` on top of `src/main/*` for `assembleDebug`,
and this never runs for `assembleRelease`/`bundleRelease`:

- [`client/android/app/src/debug/AndroidManifest.xml`](../../client/android/app/src/debug/AndroidManifest.xml)
  adds `android:networkSecurityConfig="@xml/network_security_config"` to `<application>`.
- [`client/android/app/src/debug/res/xml/network_security_config.xml`](../../client/android/app/src/debug/res/xml/network_security_config.xml)
  permits cleartext to `10.0.2.2` only.
- [`client/android/app/src/debug/assets/capacitor.config.json`](../../client/android/app/src/debug/assets/capacitor.config.json)
  is a static, checked-in copy of the root `client/capacitor.config.json` with
  `androidScheme` flipped to `"http"`. Android's asset merger prefers a build-type source
  set's file over `src/main`'s for the same path, so this file — not the real (gitignored,
  `cap sync`-generated) `src/main/assets/capacitor.config.json` — is what ships inside a debug
  APK. **If you ever change `appId`, `appName`, or `webDir` in the root
  `client/capacitor.config.json`, update this file to match** — it's a static duplicate, not
  generated, and there's no build step keeping the two in sync.

Verified (see the PR this shipped in for the full trail): `unzip -p app-debug.apk
assets/capacitor.config.json` shows `"androidScheme": "http"` in a debug build, while
`./gradlew processReleaseMainManifest` produces a manifest with **no**
`networkSecurityConfig` attribute at all, and the release-merged
`capacitor.config.json` still says `"https"`. The production app's networking behavior is
completely untouched by any of this.

Physical device testing (rather than the emulator's `10.0.2.2` alias) would need `adb reverse`
plus adding that alias/IP to the debug network security config — not set up here since the
scout/ship work only covered the emulator.

## Adding a new test

1. Copy the shape of an existing screen test (e.g. `tests/orders.test.mjs`): wrap the body in
   `withSession(async (driver) => { ... })` from `helpers/driver.js` (connects, switches into
   the `WEBVIEW_com.leyble.hub` context, tears the session down afterwards), call
   `loginAs(driver)` from `helpers/auth.js` to start authenticated on `/dashboard`, then
   `navigateTo(driver, '<path>')` to reach the screen through the nav drawer.
2. Prefer `data-testid`-based selectors (`helpers/ui.js`'s `waitForTestId`/`clickTestId`/
   `allTestId`) over visible text or structural XPath — every screen's list container,
   filter/search control, list item, and detail-view root already carry one (see "`data-testid`
   hooks" above). Add a new one, following the existing `<screen>-list` / `<screen>-<field>`
   naming, if the screen you're covering needs a hook that doesn't exist yet — that's a markup
   attribute only, no behavior change.
3. A native (non-WebView) interaction — e.g. a system permission dialog, or eventually a native
   plugin screen — doesn't need the context switch; drive it directly against the default
   `NATIVE_APP` context with the same `driver.$()` API but Android accessibility-id / resource-id
   selectors instead of CSS/XPath.
4. Register a script in `package.json` (`"test:<name>": "node tests/<name>.test.mjs"`) so the
   run sequence in this README stays copy-pasteable.

## Why this isn't in CI

It needs a headed emulator, a running backend against a real (dev) database, and an installed
APK — none of which fit the existing JVM/unit-test CI shape, and unlike those suites this one
has real flake surface (WebView attach timing, orientation-dependent click behavior — see the
`execute()`-based click in `login.test.mjs` for a workaround already needed once). Treat it like
manual emulator QA today: something a person (or an agent under explicit instruction) runs
before/after a risky change, not something blocking every PR.
