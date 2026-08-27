# V3.0 Slice 5 — Remove V2 screens, V2Shell, and V1↔V2 bridge

**Branch:** `fm/leyble-hub-v3-s5-v2-removal`
**Base branch:** `v2.5-offline-access`
**PR:** (see status file / PR link below)

## Summary

App now opens directly on **Outgoing Orders** (`/orders`) for authenticated users. Removed the
`preferred_ui`-based dual-shell system entirely: the `/v2/*` route tree, `V2Shell`, the 3-second
long-press bridge on the Sidebar logo, and every V2-only screen/component that became dead once
POS tile order creation was re-hosted inside V1's `OrderCreateModal` (PR #41).

### Deleted files

**Screens / shell:**
- `client/src/components/layout/V2Shell.jsx`
- `client/src/pages/pos/POSPage.jsx`
- `client/src/pages/inventory/InventoryV2Page.jsx`
- `client/src/pages/customers/CustomersV2Page.jsx`
- `client/src/pages/shared/V2Placeholder.jsx` (already unused, no importers)

**V2-only POS components** (transitively dead once `POSPage` was removed):
- `POSReviewModal.jsx`, `AmberEditHeader.jsx`, `POSConfirm.jsx`, `POSListModal.jsx`,
  `OrderViewModal.jsx`, `POSCustomerSearch.jsx`, `POSDraftsModal.jsx`, `POSHistoryModal.jsx`,
  `POSOrderPanel.jsx`, `POSSavePriceModal.jsx`

**V2-only detail drawers** (parallel V2 versions of V1's `CustomerDetailPanel.jsx` /
`ProductDetailPanel.jsx`, only imported by the V2 pages above):
- `client/src/components/customers/CustomerDetailDrawer.jsx`
- `client/src/components/inventory/ProductDetailDrawer.jsx`

### Preserved (verified still wired up and used)
- `POSProductGrid.jsx`, `CaseStepper.jsx`, `posMath.js` — used by `OrderCreateModal.jsx`
- `OfflineMarker.jsx` — used by `AppLayout.jsx` and `Sidebar.jsx` (already `variant="v1"`)
- `NeedsAttentionModal.jsx` — used by `OfflineMarker.jsx`
- `client/src/utils/orderRef.js`, `client/src/offline/*` — untouched
- `sensorLandscape` in `android/app/src/main/AndroidManifest.xml` and single `com.leyble.hub`
  appId in `capacitor.config.json` — untouched, now covered by `android-config.test.mjs`

### Code changes
- `client/src/App.jsx` — removed `IndexRedirect`, `PreferenceSync`, `PREFERRED_KEY`/`getPreferred()`,
  the `/v2` route tree and its imports. Root `"/"` now redirects straight to `/orders`.
- `client/src/components/layout/Sidebar.jsx` — removed the 3s long-press timer/progress bar,
  `startHold`/`cancelHold`, `PREFERRED_KEY`, and the "Open POS (V2)" footer link. The header logo
  is now a static, non-interactive element.

### Test changes
- Deleted (tested only removed V2 UI): `pos-history-modal.test.mjs`, `pos-review-modal.test.mjs`,
  `v2-audit-trail-components.test.mjs`
- `slice5-bridge.test.mjs` → replaced by **`android-config.test.mjs`**, keeping only the
  sensorLandscape / capacitor appId assertions (the long-press/preferred_ui tests were deleted
  along with the feature).
- `customer-detail-drawer-scroll-retention.test.mjs` → replaced by
  **`customer-detail-panel-scroll-retention.test.mjs`**, keeping only the V1
  `CustomerDetailPanel` coverage (the `CustomerDetailDrawer` (V2) tests were deleted).
- `receipt-spacers.test.mjs` — removed the one `POSCustomerSearch` test + import; the
  `receiptTemplate`/`escposReceipt`/`CustomerCreateModal`/`CustomerFormModal` tests are untouched.

## Verification

- `cd client && npm test` → **128/128 passing**.
- `cd server && npm test` (against throwaway DB `leyble_hub_v2audit`) → **81/82 passing**. The one
  failure, `V3.0 Slice 7: Orders List Pagination & Date Boundary Fix — Date boundary fix: to_date
  as YYYY-MM-DD is end-of-day inclusive`, is a **pre-existing, unrelated** bug in Slice 7's
  pagination date-boundary logic — this branch made zero changes under `server/`, so it also fails
  on `v2.5-offline-access` unmodified. Not fixed here; out of scope for this slice.
- `cd client && npm run build` → clean Vite build, no warnings/errors (114 modules, ~750ms).
- Manually pair-tested against live dev servers (see below): landing page, long-press no-op,
  `/v2/pos` redirect, New Order POS tiles, and V1 screens (Inventory, Customers) all confirmed
  working in-browser.

## Live pair-test environment

- Backend: `cd server && node src/index.js` (port 3000, dev Supabase DB `yzopwoquzfnyqdmuookw`)
- Frontend: `cd client && npm run dev` (port 5173, `host: true` in `vite.config.js`)
- **URL:** http://100.96.45.91:5173
- **Login:** `josie@leyblestore.com` / `leyble123` → pick a profile (Josie / Luis / Admin)

## Pair-test script

1. Open http://100.96.45.91:5173, log in, pick a profile. App should land directly on
   **Outgoing Orders** (`/orders`) — no POS/dashboard flash first.
2. Press and hold the "Leyble Hub" logo in the sidebar for 3+ seconds. Nothing should happen —
   no progress bar, no toast, no navigation.
3. Manually navigate to `/v2` or `/v2/pos` in the address bar. Should redirect cleanly to
   `/dashboard` (or `/orders`) — no crash, no blank/dead screen.
4. Click **+ New Order**. Tap a product tile in the grid — a line should appear in the cart panel
   with a working +/− case stepper and a live running total. Confirm order creation still works
   end to end.
5. Confirm the standing offline status pill ("Online" / "Offline · N waiting" etc.) is visible in
   the sidebar chrome on every screen, not just Outgoing Orders.
6. Click through Inventory, Customers, Personnel, Incoming Supplies, Tickets, and Audit Log —
   all should load and behave exactly as before (these are untouched V1 screens).
