# Offline price caching for order creation — deliverable report

**Branch:** `fm/leyble-hub-v3-offline-price-cache`
**Base:** `v2.5-offline-access`
**Backlog decision:** `leyble-hub-v3-s2-blast-radius-decision-offline-pricing-gap`

## Summary

PR #40's blast-radius review found that `client/src/offline/catalogue.js` cached
products and customers for offline selling, but not `customer_product_prices`. Under
[ADR 0009](../../docs/adr/0009-custom-pricing-derived-from-saved-prices.md), saved
prices are the pricing source for **every** customer, not just ones tagged
wholesaler/discounted/markup. `OrderCreateModal.jsx`'s saved-price fetch had a bare
`.catch(() => {})`, so when the tablet was offline the fetch failed, `customPrices`
stayed `{}`, and all ~141 accounts with agreed rates were silently billed base
wholesale price — a stated promise (D16: the store can sell blind) the app was not
keeping.

This PR closes the gap by caching saved prices in native storage, following the exact
same "try live, fall back to the held copy, never throw" shape the existing
product/customer catalogue cache already uses.

## What changed

- **`client/src/offline/keys.js`** — `customerPricesKey(customerId, orderType)`, one
  native-storage key per (customer, order_type) pair
  (`v25.catalogue.prices.<customerId>.<orderType>`).
- **`client/src/offline/catalogue.js`** —
  - `getCachedCustomerPrices(customerId, orderType)` reads the held copy.
  - `loadCustomerPrices(customerId, orderType)` tries
    `GET /customers/:id/prices?order_type=...` first, writes the result to native
    storage on success, and falls back to the cached copy on failure. Never throws,
    mirroring `loadCatalogue()`'s existing contract.
  - Caching is **lazy, per (customer, order_type)** rather than swept into the
    whole-catalogue refresh — there's no bulk "all saved prices" endpoint, and eagerly
    pulling ~141 accounts × 2 order types on every quiet refresh would be hundreds of
    requests for rates most of which are never sold against before the next refresh.
    The cache fills in with exactly the customers a device has actually taken orders
    for.
- **`client/src/pages/orders/OrderCreateModal.jsx`** — the saved-price effect and
  `hasAnySavedPrice()` (the mis-tagged-customer nudge) both now route through
  `loadCustomerPrices()` instead of calling `api.get` directly, so both apply the
  cached rate — and the nudge still fires — when offline.
- **`docs/adr/0009-custom-pricing-derived-from-saved-prices.md`** — new "Addendum:
  offline pricing gap closed" section documenting the gap and the fix, cross-linked to
  ADR 0004/0007.
- **`client/test/offline-prices.test.mjs`** (new) — 7 tests: caching/retrieval
  keyed correctly per customer and order_type, fallback to cache on live-fetch
  failure, never-throws on an empty cache, and full `OrderCreateModal` integration
  tests (online priming, offline cache hit billing the agreed rate, offline
  cache-miss falling back to base price, and the mis-tagged-customer nudge still
  firing from cache while offline).

## Verification

- `cd client && npm test` — **135/135 pass** (includes the 7 new tests).
- `cd client && npm run build` — clean, no warnings.
- `cd server && npm test` — **81/82 pass**. The one failure
  (`v3-s7-orders-pagination.test.js`, "Date boundary fix: to_date as YYYY-MM-DD is
  end-of-day inclusive") is **pre-existing on `v2.5-offline-access`** — this PR makes
  no server-side changes at all (`git diff` touches only `client/` and `docs/`), and
  the failure looks environment/timezone-dependent (asserts orders placed "today"
  relative to the test machine's clock). Flagging for visibility, not fixed here as
  it's out of this PR's scope.

## Live pair-test environment

- **URL:** http://100.96.45.91:5173
- **Login:** `josie@leyblestore.com` / `leyble123`
- Backend (port 3000) and frontend (port 5173) are running against the **dev**
  Supabase DB (`yzopwoquzfnyqdmuookw`), using `server/.env` copied byte-exact from the
  shared dev environment.

### Pair-test script

1. **Online baseline.** Open http://100.96.45.91:5173, log in, pick a profile, go to
   **Outgoing Orders → New Order**. Select a customer with saved delivery prices —
   e.g. **Cagayan Rice** (17 priced products, tagged `discounted`) or **911** /
   **Dorothy** / **Eva** (wholesalers with 20+ priced products each). Confirm the
   green "✓ Saved delivery prices applied (N products)" banner appears and the
   product tiles show the agreed rate (not base price). This also caches those rates
   to the device.

2. **Simulate offline.** Open the browser console and run
   `window.__leyble.simulateOffline(true)`. The offline pill in the header should
   change to **Offline**.

3. **Offline order taking.** With the same customer (e.g. Cagayan Rice) still
   selected, or reselect them: confirm the saved-prices banner still appears and
   added items still price at the agreed rate — not base price. This is the actual
   fix: previously this would have silently reverted to base price.

4. **Negative check.** Select a `regular` customer with no saved prices — e.g.
   **2 brothers**, **2bud**, **AJOC**, **Alcober**, or **Aling Glo** — and confirm no
   saved-prices banner appears and added items price at the standard base rate. This
   confirms the fallback path doesn't fabricate a discount where none exists.

5. **Save the order offline.** Finish the order (add items, assign personnel if
   required, Save/Confirm). Confirm it lands in the local outbox — the offline
   indicator should show a "waiting to sync" count, and the order should carry the
   agreed custom price on its line items (check the order summary/total before
   saving).

6. **Return online.** Run `window.__leyble.simulateOffline(false)` in the console.
   Confirm the outbox drains — the waiting count should clear and the order should
   sync through with the correct (agreed) pricing intact.

## Steps to replicate (code-level)

1. In `client/src/pages/orders/OrderCreateModal.jsx`, the customer/order-type effect
   around line 145 now calls `loadCustomerPrices(customerId, orderType)` (imported
   from `../../offline/index.js`) instead of `api.get` directly.
2. `client/src/offline/catalogue.js` exports the new `getCachedCustomerPrices()` and
   `loadCustomerPrices()` functions, re-exported through
   `client/src/offline/index.js` (already a wildcard re-export of `catalogue.js`, no
   change needed there).
3. To inspect a cached entry directly in a dev console:
   `await window.Capacitor?.Plugins?.Preferences?.get({ key: 'v25.catalogue.prices.244.delivery' })`
   (native builds) or check `localStorage.getItem('v25.catalogue.prices.244.delivery')`
   in browser dev mode (customer id 244 = Cagayan Rice).
