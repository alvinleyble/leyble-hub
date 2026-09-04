# CLAUDE.md — Leyble Hub

Private internal admin app for a local beverage distributor in Antipolo, Philippines.
Primary users: business owners (late 50s). Currency: Philippine Peso (₱). Not customer-facing.

---

## Reporting changes back to Alvin

Every time you summarize changes you made, end with a short **"Steps to replicate"** section —
numbered steps telling Alvin exactly where to click/navigate in the running app to see and test
the change himself (page/tab name, what to select, what action to take, what to expect). He
should never have to guess where to find what changed.

---

## Running the project

```bash
# Backend (port 3000)
cd server && node src/index.js

# Frontend (port 5173)
cd client && npm run dev
```

Vite dev proxy: `/api` → `http://localhost:3000`
DB: `DATABASE_URL` (points to the development Supabase database; see [docs/operations/development-database.md](docs/operations/development-database.md))
**Never expose `server/.env` contents** — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`.

### Tests

```bash
# API integration suites — run against a throwaway DB, never the dev one
createdb leyble_hub_v2audit && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit node server/db/migrate.js
# The V2.5+ suites resolve their acting user by email, so a migrated-only DB
# cancels them wholesale with "Cannot read properties of undefined (reading 'id')".
# setup-accounts.js only ACTIVATES existing rows — a fresh DB has none, so insert them:
psql -d leyble_hub_v2audit -c "INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES \
  ('josie@leyblestore.com','x','Josie','admin',TRUE), \
  ('luis@leyblestore.com','x','Luis','admin',TRUE), \
  ('alvin@leyblestore.com','x','Admin','admin',TRUE);"
# `npm test` runs the files ONE AT A TIME (--test-concurrency=1). Several suites assert
# on state that is global to the database — which device holds each of ADR 0016's three
# a person's device letters, what the orders list contains, where a sync cursor has reached — so run
# them in parallel and they fail each other at random. Serial takes ~2 minutes; CI does
# not run this suite at all (it only syntax-checks), so the cost is local only.
cd server && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit \
  JWT_SECRET='test-jwt-secret-key-32-chars-minimum!!' npm test

# Component tests (jsdom + react-dom, no framework; client/test/jsx-register.mjs
# transforms .jsx with esbuild so the real components import directly)
cd client && npm test

# Pure client modules (posMath, ESC/POS + HTML receipts)
node --test audit-client.test.mjs
```

On-device UI (Appium, manual/on-demand — not part of CI): [e2e/appium/README.md](e2e/appium/README.md).

The server suite is **timezone-sensitive**: on a local Postgres running `Asia/Manila` three cases
fail before any code change (two forward-cursor cases in `v3-s32-orders-sync.test.js`, and the
`to_date` end-of-day case in `v3-s7-orders-pagination.test.js`, whose 20:00 UTC fixture lands the
next day locally). Put the throwaway database in UTC once and all 158 pass —
`psql -d <db> -c "ALTER DATABASE <db> SET timezone TO 'UTC'"`. `PGTZ` does **not** work; node-pg
does not pass it through.

`server/test/v2-accuracy-audit.test.js` + `audit-client.test.mjs` come from the V2 accuracy audit
and deliberately **pin some still-broken behaviour** (the closed-order deposit total, the ESC/POS
non-ASCII bytes, the blank no-SKU receipt line). Invert those assertions as each fix lands rather
than treating a passing run as "all correct".

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT in HTTP-only SameSite=Strict cookies |
| Database | PostgreSQL 15+, `NUMERIC(10,2)` for money, `TIMESTAMPTZ` for timestamps |

---

## Key conventions

### Database
- Migrations live in `server/db/migrations/NNN_name.sql`. **Never modify an applied migration** — always add a new one.
- **Prove a schema change against a local throwaway database, never against the shared development
  database** (the `createdb` recipe under [Tests](#tests) is the whole setup). The shared development
  database is only ever brought forward by a migration that has already merged — applying an unmerged
  change to it by hand puts it ahead of the landed code, so the migration can no longer replay there.
- Guard every migration statement so a re-run is a no-op (`IF NOT EXISTS` / `IF EXISTS`, `DROP
  CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, a `DO` block around a generated-column rebuild),
  and make the end state identical whichever path a database arrives by. Reference:
  [040_receipt_device_letter.sql](server/db/migrations/040_receipt_device_letter.sql).
- `inventory_audit_logs`, `customer_product_prices`, and `activity_logs` are **append-only** — never `UPDATE` or `DELETE` these tables.
- `order_items.line_total` is a PostgreSQL `GENERATED` column — never write to it directly. Since migration 023 the formula is `quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee` (deposit charged on un-returned bottles).
- Multiple personnel per order via `order_personnel` join table (not FK columns on `orders`).
- **At most one Driver per order** — validated in `syncPersonnel` in
  [server/src/routes/orders.js](server/src/routes/orders.js) (400 on >1 Driver). V3.5 removed
  the Driver/Helper picker UI from order creation (no viewport shows it any more — a settled
  product decision, not a bug); `OrderCreateModal.jsx` still loads and round-trips an existing
  order's `assignedPersonnel` unedited on save so historical assignments survive an edit.

### Pricing and stock — the two rules that are invisible on screen

**Saved prices are the pricing source** ([ADR 0009](docs/adr/0009-custom-pricing-derived-from-saved-prices.md)).
A customer gets custom pricing when `customer_product_prices` has rows for them on that
`order_type` — never because of what `customer_type` says. `customer_type`
(`regular`/`wholesaler`/`discounted`/`markup`) is a **label the owners read**, nothing else.
Ask [`client/src/utils/customerTypes.js`](client/src/utils/customerTypes.js) (`hasCustomPricing`,
`customerTypeLabel`, `customerTypeBadge`, `normalizeCustomerType`) rather than testing the string
in a new screen — the old per-screen type lists are exactly how agreed prices went unread for 35
live accounts. Saving a price never re-tags the customer.

**Only the explicit prompt writes a saved price.** `POST /customers/:id/prices`, from the
"Save Custom Price?" dialog, is the sole writer; `insertItems` deliberately writes none.
`order_items.is_price_overridden` means "hand-typed on this order", not "this is their standing
rate" — order-save used to write a `customer_product_prices` row on that flag alone, before the
operator was asked, so answering **No** changed nothing and a one-off price became permanent with
no way back (the table is append-only and has no delete endpoint).

One nudge sits on top of that rule, not against it: picking a **`regular` customer who holds
saved prices** in the New Order modal prompts to retag them (Markup / Discounted / Wholesale /
Skip), because that combination means the tag is lying about the account. Pricing is unaffected
either way — the prompt only corrects the label — and it deliberately has no dismissal memory, so
it asks again until someone fixes the tag.

**Stock deducts at dispatch, not at save** ([ADR 0012](docs/adr/0012-stock-deducts-at-dispatch-not-at-save.md)):
`pending → in_transit` for a delivery, `pending → completed` for a pickup. Creating, finalizing
and draining an order move nothing, which is what keeps inventory out of the offline path. Every
stock decision is gated on `isStockOut()` (net audit-log delta), not on the status name — see
[docs/architecture/order-lifecycle.md](docs/architecture/order-lifecycle.md#stock-movement).

### Frontend patterns (follow these exactly — consistency matters)

**Searchable combobox** (product pickers everywhere):
- Text input + dropdown, filter on keystroke via `productMatches()` from
  `client/src/utils/productSearch.js` — punctuation-insensitive ("c8" matches SKU "C-8")
  and also matches name/category, so every product search bar must use it
- `onFocus`/`onBlur` + `setTimeout(150)` before closing so `onMouseDown` fires before blur
- Reference: `client/src/pages/orders/OrderCreateModal.jsx`

**Side panel** (detail views):
- `fixed inset-0 z-40` backdrop + `fixed right-0 top-0 h-full w-full max-w-lg` panel
- Reference: `client/src/pages/personnel/PersonnelDetailPanel.jsx`

**Modal** (create/edit forms):
- `fixed inset-0 z-50 flex items-start justify-center`
- Reference: `client/src/pages/personnel/PersonnelFormModal.jsx`

**PHP formatter** (defined locally in each file — do not centralize):
```js
const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
```

**API calls**: `api.get/post/patch/del` from `client/src/api/client.js`, always with `credentials: 'include'` (already set in the client).

**Toasts**: `const { addToast } = useToast()` → `addToast(msg, 'success' | 'error')`.

**Responsive layout**: the permanent sidebar only renders on the custom `desktop:` screen
(`min-width: 1024px` **and** `pointer: fine`, see `client/tailwind.config.js`); phones/tablets
get the hamburger drawer in both portrait and landscape. Width-based `sm:`/`md:`/`lg:` are
still used for everything else (table columns etc.).

### V2 tablet shell (in progress — see [docs/product/proposals/v2-tablet-pos-overhaul.md](docs/product/proposals/v2-tablet-pos-overhaul.md))

The V2 tablet POS overhaul lands slice by slice **alongside** V1, not in place of it:
- **Two shells, two route trees.** `/v2/*` renders `client/src/components/layout/V2Shell.jsx`
  (dark slate, POS/Inventory/Customers); every pre-existing route keeps its
  path and its V1 `AppLayout`. Never repoint or delete a V1 route — add V2 screens under `/v2`.
- **Dark tokens are V2-only.** `v2-*` colors and `min-h-tablet` (52px) in
  `client/tailwind.config.js` are for V2 shell/screens; V1 pages stay light. The V2 focus ring is
  re-tinted via the `.v2-root` rule in `client/src/index.css`.
- **Back Office** (Personnel, Incoming Supplies, Tickets, Audit Log) stays V1 UI permanently.
- All V2 slices merge to `staging` only; `main` is merged once at the end (batched APK cutover).
- **POS (Slice 1, done):** [client/src/pages/pos/POSPage.jsx](client/src/pages/pos/POSPage.jsx) plus
  `client/src/components/pos/`. Order math lives in `posMath.js` — every POS figure and the
  printed receipt are **goods-only**: V2 never charges or shows the bottle deposit, because it
  never reaches the closing step where returns are counted (captain correction 2026-08-20,
  reversing proposal §2.4 — lines still carry `unit_deposit_fee` for V1's close flow). POS copy
  says "order", never "ticket". Two popups share `POSListModal.jsx`: History (Created +
  Cancelled) and Drafts (`status=draft`, resume puts the draft back on the POS keeping its id).
  Catalogue cards price through `priceFor` — the picked customer's rate for the current
  channel — badged with the gap from standard (`−₱55.00 (18.3%)`, emerald for a discount
  via `--v2-discount-badge-*`, the purple `--v2-suki-badge-*` for the rarer markup).
  **Save Order reviews the draft; it does not create the order.** `handleReview` flushes
  the cart onto the draft and opens `POSReviewModal` on it, so nothing exists and no
  stock moves until **Confirm & Print** (`handleConfirmPrint` → `POST /:id/finalize`,
  which keeps the same id, so the number reviewed is the number printed). That makes the
  review's other actions free: **Discard** is `DELETE /orders/:draftId` — a real delete,
  exactly like V1's *Discard draft* — **Draft** parks it in Drafts and blanks the screen,
  and Escape / backdrop / ✕ just go back to the cart. Never word any of this as
  "closing" an order: that is the settlement step (returns counted, status `done`).
  **The review modal is for drafts and only drafts** — the saved panel offers Print /
  Edit Order / New order, nothing that reopens it. Reading back an order that already
  exists is a separate job: History's 👁️ View opens `OrderViewModal.jsx` (shared with the
  Customers drawer's order history — it moved out of
  `components/customers/CustomerOrderDetailModal.jsx`). It never edits the order inline;
  it leads with ↩️ Back to the list behind it, and takes optional `onEdit`/`onReprint`/
  `onCancel` so History can hoist its row actions onto the open order (greyed out once
  cancelled). Omit them, as Customers does, and it is purely read-only. A Created order is never discarded, only cancelled from History,
  where it stays visible as 🚫 Cancelled. Leaving Edit Mode restores whatever was parked,
  print buffer included. The debounced draft save also parks the adjustment (its own
  endpoint), and neither the POS nor `insertItems` accepts a negative price.
  Both top-bar buttons carry count badges; the "not printed" badge tracks all-time unprinted
  pending orders, and the History modal supports date filtering presets (Today, Yesterday,
  Last 7 Days, All Time) with a bulk mark-as-printed action.
  The POS surfaces only Draft / Created (`pending`) / Cancelled and never writes
  `order_personnel`; Amber Edit Mode cannot change customer or order type (backend accepts those
  on drafts only). Its zero-prompt 2-copy print reuses `usePrintReceipt` via
  `options.copies` / `options.autoTag` (receipts derive deposit display from status: goods-only
  for pending, deposit shown on completed/done) — V1's prompts and receipts are unchanged.
- **Inventory (Slice 2, done):** [client/src/pages/inventory/InventoryV2Page.jsx](client/src/pages/inventory/InventoryV2Page.jsx)
  plus `client/src/components/inventory/`. Ships with zero backend changes — batch price edit
  (`InventoryBatchPriceModal.jsx`, reason required client-side), in-line price edit and the
  `w/ dep` toggle (both inline in `InventoryV2Page.jsx`, PATCH `/products/:id` per field) and the
  product detail/audit drawer (`ProductDetailDrawer.jsx`, "Adjust Stock & Audit" + "Recent Stock
  Movements") all reuse V1's existing `products` routes as-is. The physical stock count sheet
  (`productCountSheetHtml`/`productCountSheetEscPos` in `pages/shared/`) is new and distinct from
  V1's price-list print — blank `Counted:` line per item instead of the system count. No per-row
  `−1`/`+1` steppers (V1 had none in its table either).

### V2.5 offline core — re-hosted on V1's screens (Slice 3, see [docs/product/proposals/v2-5-offline-accessibility.md](docs/product/proposals/v2-5-offline-accessibility.md))

Order-taking is local-first every day: the device saves locally, issues its own receipt
number, prints, and a background outbox drains when the line is up. Design is closed
(18 decisions, all in that proposal); ADRs 0003–0008 hold the load-bearing ones. What
was originally built against the V2 POS screens now runs on V1's own screens —
`OrderCreateModal.jsx` (local-first save + `local-*` quick-created customers),
`OrderDetailPage.jsx` (local fallback + silent sync + offline editing), and
`CustomersPage.jsx` (queued-customer visibility). The V2 POS screens (`POSPage.jsx`
etc.) still exist and still use the same engine underneath, unrelated to the V1 path.

- **The engine itself now starts unconditionally** — `startOfflineCore()` in
  `client/src/offline/index.js` no longer gates registration/drain on
  `V25_OFFLINE_CORE`; V1's `OrderCreateModal` calls `saveOrderLocalFirst()`
  unconditionally too, so the station has to be able to register and the outbox has to
  be able to drain in every build, flag or no flag. `V25_OFFLINE_CORE` still gates pure
  UI/display concerns (the marker, `orderRef()`'s receipt-number fallback).
- **Two differently-shaped draft-cleanup functions live in `posSave.js` — do not
  confuse them.** `cleanupOrphanedDraft` (outbox-queued, retried indefinitely) is for
  the V2 POS's blind-print case, where the draft's row id is the only way to reach it
  later. `cleanupOrphanedDraftDirect` (a bare fire-and-forget `api.del(...).catch(()
  => {})`, never queued) is what V1's `OrderCreateModal` uses for the early draft it
  creates on customer-pick — queuing that cleanup through the outbox was the rejected
  PR #41's exact bug (a throwaway delete stuck ahead of/behind real order POSTs,
  wedging "Offline · N waiting" for minutes).
- **Silent background sync** — `drainNotifier.js` dispatches a
  `window` `CustomEvent('leyble:drain-complete', { detail: { sent, waiting } })`
  whenever a drain sends something, independent of both the `V25_OFFLINE_CORE` flag
  (this is a sync signal, not a display concern) and the once-per-outage toast latch.
  `OrderDetailPage.jsx` listens for it and re-reads with `silent: true`, which never
  touches `loading` — that's what keeps the swap from a local "Waiting to sync" row to
  the synced server row spinner-free. **Every caller of `drainOutbox()` that can fire
  outside the 30s periodic loop must route its result through `handleDrainCompletion`
  itself** (Round 2 Fix 1) — `posSave.js`'s three background drains (the immediate
  post-save drain in `saveOrderLocalFirst`, `queueReceiptPrinted`, and
  `updateLocalOrder`) are what actually land an order on the server in practice, ~1s
  after Save, not the periodic loop; calling the bare `drainOutbox()` from
  `outbox.js` without also calling `handleDrainCompletion(res)` on a successful send
  is silently correct in every way except that no screen ever hears about it.
- **`drainOutbox()` self-reruns instead of stranding a skipped call** (Round 3 Fix 5).
  A `drainOutbox()` call while another pass is already in flight returns
  `{skipped:true}` immediately (`draining` mutex) — but the record it just enqueued
  was not necessarily in that in-flight pass's own `records` snapshot (taken at the
  START of that pass), so without a follow-up it would sit `QUEUED` until whatever
  unrelated thing next calls `drainOutbox()` (the 30s periodic loop, an `online`
  event, another save). `outbox.js` now schedules an immediate follow-up pass itself
  the moment the in-flight one finishes, and routes a successful rerun through
  `handleDrainCompletion` exactly like every other drain path — this is what the
  chrome-wide `OfflineMarker` showing "N waiting" for minutes after an unrelated
  order's own banner had already cleared turned out to be.
- **G28's real-time offline editing also covers the adjustment** (Round 3 Fix 4) —
  `OrderDetailPage.jsx`'s `saveAdjustment` writes through `updateLocalOrder()` while
  `unsynced`, same as the rest of an offline edit, and falls back to the ordinary
  `PATCH /orders/:id/adjustment` once synced. It was previously the one control left
  hard-disabled with no offline path of its own, contradicting the rest of G28.
- **A remembered `$ref` survives 24h regardless of who currently depends on it**
  (Round 4 Fix 6, `outbox.js`'s `pruneRefs`/`REF_PRUNE_GRACE_MS`). Its old behaviour —
  deleting a synced dependency's ref the moment nothing *yet enqueued* referenced it —
  raced a quick-created customer (drains and remembers her ref in one pass) against
  the order that would depend on her (enqueued moments later, once the operator
  finishes the rest of the order): the ref was already gone before the order could
  ever need it, and `resolvePayload` then threw `unresolvedRef` on every future pass,
  forever, with zero attempts counted and no visible signal — a customer/order created
  back-to-back is exactly this shape, not a rare edge case. The residual case the
  grace window can't rule out (a dependent enqueued only after it fully elapses) is
  caught by the drain loop's `NEEDS_ATTENTION` escalation: a record whose dependency
  id is nowhere in the current outbox snapshot at all (not queued, not needing
  attention itself) surfaces immediately in the attention list instead of staying
  silently `queued` forever — there was previously no in-app recovery path for this at
  all (a stuck record had to be hand-patched in native storage).
- **OrdersPage merges in locally-created/unsynced orders** (Round 4 Fix 7), the same
  `listRecords()`-into-the-server-list pattern G29 already established for
  `CustomersPage.jsx`. Before this, a purely server-driven list meant navigating away
  from a freshly-created offline order and back lost it entirely — clicking back in
  landed on whatever unrelated, already-synced order happened to occupy that stale
  numeric-id row. Merged rows navigate by `receipt_number`, never a numeric id (there
  isn't one yet), round-tripping correctly to `OrderDetailPage`'s existing local-
  receipt-cache fallback. Scoped to the `all`/`pending` tabs and excluded from bulk
  selection and the duplicates filter — a still-local order has no server row yet to
  act on or meaningfully flag as a duplicate against.
- **Dev-browser persistence (Round 2 Fix 3):** on a plain desktop browser (not the
  Android APK), `nativeStore.js` backs onto `window.localStorage` when available
  (falling back to an in-memory `Map` only if localStorage throws or is absent, e.g.
  private browsing or the Node test runner) — a page reload now survives with the
  outbox, receipt history, and station registration intact. D17's WebView-storage ban
  is about the production APK specifically (Android evicts it, "clear data" wipes it);
  it was never a reason to also wipe a developer's own browser tab on every reload,
  and doing so caused a real bug: `station.js` only registers a new station when none
  is stored locally, so every reload looked like a brand-new device and minted a fresh
  station number from the server (reproduced live as station numbers climbing past 40
  from one login). Production is unaffected — the APK always uses `preferencesBackend`.
  Tests are unaffected — every offline test file forces the in-memory backend via
  `__resetMemoryBackend()` in its own `beforeEach`, regardless of what's available.
- **The off switch is `V25_OFFLINE_CORE`** in `client/src/config/features.js` — build-time
  (`VITE_V25_OFFLINE_CORE=on`), off by default, reused by every piece. Off must be
  indistinguishable from today. **Migrations are NOT behind it** (Render runs
  `server/db/migrate.js` on every deploy to the one production environment), so every
  V2.5 migration must be additive and correct standing alone. The server needs no flag:
  its new behaviour is reachable only when a request carries a `receipt_number` or a
  device `created_at`, which only a switched-on client sends.
- **The person number and the device letter** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md)
  #1/#2/#3, migration 043). The leading number is the **signed-in account**
  (`users.receipt_person`) — permanent, never reused, seeded as Alvin 1 / Josie 2 /
  Luis 3 and allocated `MAX+1` to anyone else on their first device claim. The letter is
  allocated per **person-and-device pair** (`user_devices`) on that person's first
  successful *online* sign-in on that device, walking strictly forward A..Z, AA..ZZ
  (`server/src/lib/deviceLetters.js`) — never gap-filling, because a letter a dead tablet
  used could collide with receipts it never synced. The same physical tablet is `1A` for
  Alvin and `2A` for Josie; the letter is never globally meaningful. **A replacement
  device signs in and takes a fresh letter — there is no device list, no assignment UI
  and no admin action**, which is what removes ADR 0016's high-water seeding and
  `REASSIGN_RESERVE`. Both allocations happen in `POST /stations/register`, which
  `startOfflineCore` already calls on every start; the device remembers the pair under
  `v25.deviceLetters` (a map, one entry per person) and issues locally from then on.
  **`ensureStationRegistered` is serialised through one in-flight promise** — two
  overlapping calls on a device that has never registered would each mint their own
  `device_key` and burn a second letter, which React StrictMode's double-invoked effect
  reproduces on every dev sign-in.
- **Remembered accounts and offline switching** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md)
  #7, `client/src/offline/accounts.js`). A device remembers every account that has
  **successfully signed in on it** (`v25.accounts`, one entry per account) and switching
  between them is two taps, no password, no server round trip — that is what replaced the
  deleted profile picker, and it has to work mid-blackout. A person's FIRST sign-in on a
  device still needs a connection (ADR 0015 §2), which is why nothing but a successful
  login ever adds to the list. `switchAccount` in `AuthContext` swaps `v25.session`, which
  is what `station.js` reads to pick that person's device letter for the next receipt.
  Device state, so it survives logout, a 401 and a takeover; only an explicit "forget"
  removes an account. **The account's JWT is deliberately NOT in `v25.` storage** — it
  sits in `api/client.js` under `accountToken.<email>`, native `@capacitor/preferences`
  only, memory on the web dev tier, because `nativeStore` falls back to `localStorage` in
  a dev browser and the security rules forbid a JWT landing there. An entry with no held
  token is still switchable (an ADR 0015 §3 offline session); it just asks for the
  password once the line is back.
- **The outbox drains each record under the account that SAVED it.** Now that one device
  can hold two signed-in people, `record.profile_key` (D14) is back on the wire — not as
  the impersonation header ADR 0017 §5 deleted, but as that person's own remembered token,
  via `api.request(..., { accountKey })`. It matters because `orders.created_by` is what
  prints `Sold by:` on the receipt. No token held, or the author IS the active session:
  the ordinary active token, and attribution stays honour-system as accepted.
- **A 401 during a drain leaves every record QUEUED and stops the pass.** A dead session
  says nothing about the records, and ADR 0017 #8 makes "a takeover never discards
  receipts waiting to sync" a hard requirement — never mark them `NEEDS_ATTENTION`, never
  drop them. The 401 path in `api/client.js` clears session state **by name** (the active
  token, `activeProfile`, that one account's remembered token) and nothing under `v25.`.
- **ADR 0016's slot concept is gone** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md) #3):
  the `/devices` screen (`StationsPage.jsx`), `GET /stations`,
  `POST /stations/slots/:slot/assign`, `REASSIGN_RESERVE`, the slot high-water seeding and
  the owner-name vocabulary all existed only to keep a *hardware*-keyed number alive
  across a hardware change. A replacement device now signs in and takes a **fresh letter**,
  which cannot collide with anything, so none of it has a job left. `stationSlots.js` was
  renamed **`server/src/lib/personNumbers.js`** and keeps only `assertIssuableStation` (the
  `POST /orders` / `POST /incoming` backstop, no longer capped at 3 — it refuses a value
  that cannot be a person at all). `stations.slot_number` / `slot_assigned_at` /
  `slot_assigned_by` (migration 037) are left in place, written by nothing.
  **One residue is deliberate:** a device that already holds a pre-letter `station_number`
  keeps it — `persistRegistration` preserves it rather than re-deriving it from a response
  that no longer carries one — so a tablet mid-switchover keeps selling `3-00061` until its
  letter arrives (`resolveIssuingSeries`, ADR 0014's switchover window). Nothing hands a
  number of that shape out any more.
- **Receipt numbers are device-issued** (`<person><device letter>-<sequence>`, e.g.
  `1A-00042`) at Save, with no server round trip. `client/src/offline/station.js` issues
  them, off a counter keyed by the **series** (`'1A'`, or `'3'` for a device still
  carrying a pre-letter number) so two pairs on one tablet can never share a count; display goes
  through `orderRef()` in `client/src/utils/orderRef.js` — use it anywhere an order was
  shown as `#<id>`. The row id stays internal. Pre-V2.5 orders have no receipt number and
  are never backfilled. Screens that hold only an id (audit entries, a ticket's related
  order, a review-queue tab) use `orderRefFromId(id, receiptNumber)` and get the receipt
  number from a `LEFT JOIN orders` their query now carries — the id alone is never the
  display name ([ADR 0010](docs/adr/0010-receipt-number-addresses-order-across-sync-boundary.md)).
- **Three receipt-number formats coexist permanently and the server takes all three**
  ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md), which supersedes
  ADR 0016): the ~1,300 legacy `#1240` orders (no receipt number at all), the pre-letter
  `3-00061`, and `3A-00001` — the leading number is the **person**, the letter their own
  device. Delivery references take the same shape (`1A-DEL-00007`). **Old-format
  acceptance is never removed** — tablets update one at a time over days, so an
  un-updated one is still issuing the old shape while an updated one may still hold
  unsynced old-shape receipts (ADR 0014's ADR-0017 switchover ordering).
  `parseReceiptNumber`/`parseDeliveryRef` (`client/src/offline/receiptNumbers.js` and its
  server mirror `server/src/lib/receiptNumbers.js` — **keep the two in step**) and
  `resolveOrderId` in `server/src/routes/orders.js` all accept the letter optionally.
  **Never `ORDER BY` a receipt number** — the three shapes do not sort as text; order by
  time. The letter goes through `COALESCE(receipt_device, '')` **inside** the partial
  unique index (migration 040) and in every lookup that matches it; without that,
  NULL-is-distinct silently stops the index protecting every pre-letter row, which is
  invisible from the app — see `server/test/v3-s17-both-receipt-formats.test.js`.
- **Bare digits in order search are a SEQUENCE, never a substring** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md)
  #11). Customers read the digits off faded thermal paper and skip the prefix, so `42`
  answers with every order whose sequence is 42 across all prefixes — a disambiguation
  list carrying customer name and date, never a jump to one order. `%42%` cannot say
  that: it also drags in `3-00420`. `parseBareSequence` (both `receiptNumbers.js`
  mirrors) is the shared primitive; `orderMatchesSearch` in
  `client/src/utils/orderSearch.js` and the `search` branch of `GET /orders` are the two
  places that apply it and **must stay in step**, or the instant client-side filter and
  the server answer disagree on the same term. The row id stays in the OR because for a
  legacy order the digits ARE the id.
- **The retry key is `request_key`, NOT the receipt number** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md)
  #9, revising [ADR 0006](docs/adr/0006-receipt-number-as-idempotency-key.md), migration
  039). `outbox.js` mints one per queued record (`requestKeys.js`) and injects it into
  every POST body it drains; `POST /orders` and `POST /incoming` answer a key they
  already hold with the stored row and a `200` — never an error, never a second row, so
  the device can clear its outbox. The receipt number stays unique and stays the route
  identifier (ADR 0010); it is simply no longer what a *retry* is recognised by, so two
  different sales that collide on one number are two rows and a `409` a human can act
  on, instead of the second sale silently vanishing into the first. **The receipt-number
  dedupe path is the fallback for a record with no `request_key` (a pre-039 queued
  record, ADR 0014's mixed-fleet window) and must never be removed.** Mechanism is
  table-agnostic in `server/src/lib/idempotency.js` — `orders` and `supplier_deliveries`
  carry the same column shape, so a third table is one allowlist entry.
- **Device state lives in native storage only** — `@capacitor/preferences`, **one key per
  record**, all under the `v25.` prefix, via `client/src/offline/nativeStore.js`. Never
  `localStorage`, never IndexedDB (Android evicts them; "clear data" wipes them). It must
  survive logout: the 401 path clears `authToken`/`activeProfile` **by name** and must
  never become a prefix sweep. Browser dev falls back to memory, never to WebView storage.
- **The login session survives an evicted WebView the same way** — `client/src/context/AuthContext.jsx`
  reads/writes `@capacitor/preferences` key `v25.session` directly (not through
  `nativeStore.js`, which is outbox/catalogue state, not auth) on native builds, falling back
  to `localStorage` on web dev. A `checkAuth()` failure that isn't a genuine 401 (network
  error, timeout) restores the cached session instead of logging the operator out or
  surfacing a raw `Failed to fetch` — `LoginPage.jsx` shows a friendly "you're offline"
  message for the same failure class on the login call itself (Slice 3.1,
  [ADR 0015](docs/adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md) §3.1).
- **A last-known identity survives logout, distinct from `v25.session` above** — ADR 0015
  §3's "Resume Offline Session" login action (`LoginPage.jsx`). `AuthContext.jsx`'s
  `setStoredSession` also writes `LAST_IDENTITY_KEY` (`v25.lastIdentity`); a normal
  logout or a genuine 401 still clear `v25.session` as before but never touch this second
  key, so `getLastKnownIdentity()`/`resumeOfflineSession()` can restore the user (and
  re-populate `v25.session`) with zero server round trip after either.
- **A queued record carries the account that made it.** `enqueue()` still requires a
  `profileKey` (the signed-in account, captured at Save), but since [ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md) §5
  deleted the `X-Active-Profile` header it is **local bookkeeping only** — the drain sends
  each record under the signed-in account's own JWT, and `record.profile_key` is what the
  needs-attention list shows. The parameter and the stored field keep their pre-0017 names
  on purpose: renaming the persisted `profile_key` would orphan records already queued on a
  device that upgrades mid-outage. Slice 5's remembered accounts is what puts a per-record
  author back on the wire, once one device can hold more than one signed-in person.
- **An order's `created_at` is the device's sale time**, passed explicitly (same pattern
  as `supplier_deliveries.received_at`). No clock-skew detection — deliberately.
- **Parked orders (`client/src/offline/parkedOrders.js`):** online, unchanged —
  the pre-2.5 early-draft POST + debounced PATCH. Blind, a draft parks as an ordinary
  queued `order` outbox record (`payload.status: 'draft'`), given its own device-issued
  receipt number purely as a local identity — `server/src/lib/
  idempotency.js` is table-agnostic over any orders row, drafts included, so this reuses
  the existing mechanism rather than adding one. `POSPage.jsx`'s `draftId` holds either a
  real row id (online) or that receipt number (local park); every order route already
  resolves both (`resolveOrderId` in `server/src/routes/orders.js`). The parked-order list
  is the union of the server's drafts and this device's still-queued local ones
  (`mergeParkedOrders`), deduped by receipt number — a synced local draft simply
  disappears from the local half once the server's copy shows up. The accepted double-
  print risk (two tablets independently finalize the same parked order) is flagged, never
  guarded against, via `client/src/utils/duplicateOrders.js` + the D4 post-drain toast
  pattern (`drainNotifier.js`) and a chip in `POSHistoryModal.jsx` that opens the existing
  order-view flow.
- **The whole drafts path runs through `loadParkedOrders()`, and drafts are NOT in the
  sync.** `GET /orders/sync` excludes `status='draft'` on purpose (working state, not
  history), so a draft can never appear in `listReceipts()` — any offline fallback that
  reaches for local order history to find drafts is matching against something that
  cannot be there, which is exactly how the Drafts tab and the purple banner came to
  empty themselves the moment the line dropped. `loadParkedOrders()` in
  `parkedOrders.js` is the one code path online and offline for both surfaces: the
  server's list when it answers (cached whole under `DRAFTS_KEY`, catalogue-style, on
  the way past), that cache when it does not, unioned either way with
  `listLocalParkedOrders()` minus `pendingDeletionRefs()`. Cached server drafts are
  read-only offline (they are synced rows — ADR 0015 §5 / criterion 5.8); the ones this
  device parked carry `_local: true` and open, edit and discard with no network. **This is
  final, not provisional** — the captain reversed a more-permissive 2026-08-29 decision
  (offline edit for a synced draft) on 2026-09-02: a historical draft stays under the same
  synced-order-edit-scope lock as any other synced order, permanently. `OrdersPage.jsx`'s
  `openDraft` is what actually opens one: online it fetches and, like `OrderDetailPage.jsx`'s
  own `load()`, writes a `putOrderSnapshot`; offline it resolves that same cache via
  `getReceipt` and routes into `OrderDetailPage.jsx` read-only — never the editable
  `OrderCreateModal` draft form. `OrderDetailPage.jsx` hides Edit Order, the adjustment
  toggle and Cancel Order outright for `status === 'draft'` (absent, not just disabled).
  **`GET /orders/sync` includes drafts** (extended the same day, `server/src/routes/
  orders.js`) — the exclusion `openDraft` was built around was a leftover from Slice
  3.2, before a draft had any offline-reading requirement at all, and left a historical
  draft this device had never individually opened with no snapshot to fall back to.
  Drafts riding the same bulk history sync as everything else (`offline/sync.js`,
  status-agnostic) is now the PRIMARY path — `openDraft`'s own per-view
  `putOrderSnapshot` write is redundant belt-and-braces on top of it, not the only
  path. The list endpoint (`GET /orders`) still excludes drafts by default (a display
  concern for the All tab, overridable with `status=draft`) — that default is
  unrelated and untouched.
- **A locally parked draft carries a `display` blob beside its payload.** `payload` is
  the POST body and stays exactly that, so it has no customer name and no product
  names; `record.display` holds them, and `recordToDraft` merges the two. Without it a
  resumed offline draft comes back as nameless lines. `parkOrderLocalFirst`/
  `updateLocalDraft` write both halves together.
- **`OrderCreateModal`'s draft ref is a row id OR a receipt number**, and
  `draftLocalRef` says which. A customer picked while the server is unreachable (or a
  customer this device quick-created, who has no server id to POST) parks via
  `parkOrderLocalFirst`; the debounced autosave then rewrites that outbox record via
  `updateLocalDraft` instead of PATCHing. A local draft that drained mid-edit throws
  from `updateLocalDraft`, and the modal switches to PATCHing it by receipt number
  (`resolveOrderId` resolves both). A draft that was created on the SERVER and then
  loses the line is deliberately NOT parked locally — a second row on drain is worse
  than a stale draft — so its autosave simply retries with the full body on the next
  change.
- **The orphaned-draft trap:** any local-first save (`saveOrderLocalFirst` /
  `parkOrderLocalFirst`) creates an independent order row with its own receipt number —
  it never reuses or finalizes a pre-existing draft row. Whoever calls it MUST separately
  reconcile the draft that led to it (see `cleanupOrphanedDraft` in `posSave.js`, called
  from `POSPage.jsx handleConfirmPrint`) or that draft sits in Drafts forever. A queued
  `DELETE` that 404s (already gone) is treated as success, not a needs-attention item
  (`outbox.js drainOutbox`) — the same retry-safety D13 gives receipt numbers, extended to
  deletes via `queueOrderDeletion`.
- **The catalogue (`client/src/offline/catalogue.js`):** products/customers/**personnel**
  cache as three whole-value keys (not one-per-record — it's server-replaced reference
  data, not built up locally), refreshed quietly on every reachable load. No staleness UI,
  ever (D16). `loadCatalogue()` never throws — an unreachable server with an empty
  first-run cache just returns `[]` — and it is what `OrderCreateModal.jsx` loads its
  pickers from, online and offline alike. The held copy keeps **inactive** rows (a
  deactivation is a change a delta has to be able to deliver); the `getCached*` readers
  filter to active, so callers see the same shape as before.
- **Testing the switch-on path:** `import.meta.env` is stubbed to `{}` for every test file
  (`client/test/jsx-register.mjs`), so `V25_OFFLINE_CORE` always reads `false` there —
  component-render tests can only exercise the switch-OFF path. Functions that need
  switch-on coverage take an explicit `enabled`/`offlineCoreEnabled` override parameter and
  are unit-tested directly (see `notifyDrainCompleteWith`, `saveOrderLocalFirst`,
  `triggerOfflineAdvisoryWith`) — that is the established pattern, not a gap to fix.

### Full-app offline sync (Slice 3.2, [ADR 0015](docs/adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md))

The tablet no longer caches what it visits — it syncs **ahead of time**, because an order
viewed online but never created here had no local copy at all and still failed offline.
`client/src/offline/sync.js` owns this; read the ADR's "The Sync Model" section for the
settled rules. What a future session most needs to know:

- **Two shapes, and only two.** A tablet holding nothing does ONE full pull, ever
  (`setup_complete` in `v25.sync.state` is the only thing that decides). Every later login
  and reconnect is a delta from the device's own server-issued watermarks. Never add a
  code path that re-pulls everything on an already-set-up device.
- **`GET /orders/sync`** (registered above `GET /:id` — Express would read "sync" as an id)
  serves COMPLETE snapshots, keyset-paginated on `(updated_at, id)`: `direction=back`
  backfills newest-first and resumably, `direction=forward` is the delta. `/products`,
  `/customers` and `/personnel` take an additive `updated_since`. Migration 035 indexes
  both.
- **Merge, never clear-then-repopulate.** A sync cut off halfway must leave the device
  with more than it started with, never less.
- **`pruneReceipts()` is no longer called on start.** ADR 0015 §4 removed the 30-day age
  limit; re-adding that call deletes the history the first setup spent its one pull
  fetching.
- **`getReceipt()` resolves either identifier** — a device receipt number (`1-00042`) or a
  numeric row id (`1240`, every pre-V2.5 order, never backfilled) — via `v25.orderindex.*`
  plus a scan fallback. `putOrderSnapshot()` is the writer for server-sourced orders;
  `putReceipt()` still requires a receipt number and is for local sales.
- **"Read from the device" ≠ "never synced."** `OrderDetailPage` asks the outbox
  (`isOrderUnsynced`) rather than inferring it from the local read, because the device now
  holds synced orders too. Only a genuinely unsynced order gets ADR 0015 §5's offline
  forward transitions (`transitionLocalOrder` in `posSave.js`, queued as its own
  `POST /orders/:receipt/status` record behind the order's creation — `POST /orders` cannot
  express a status, and stock deducts on the transition, ADR 0012). Reversals, Cancel and
  Close stay online-only in every case.
- **Content edits (price, quantity, customer, adjustment, notes) follow the same unsynced-local
  boundary as status transitions** — ADR 0015 §5, settled 2026-08-28. A synced order (which
  includes every Closed order, since Close is online-only) always requires a connection to edit
  its content offline. The full acceptance-criteria list this governs, with per-item settled
  decisions, is [docs/offline-accessibility-acceptance-criteria.md](docs/offline-accessibility-acceptance-criteria.md).

### Full-app offline: back office, stock and supplies (Slice 3.3, [ADR 0015](docs/adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md) §§6–9)

Every V1 screen now works blind. What a future session most needs to know:

- **Two different caches, deliberately, and they show staleness differently.**
  `catalogue.js` holds products/customers/personnel (D16: never say how old it is —
  that is a rule about SELLING). `backOfficeCache.js` holds Dashboard, Tickets, the
  deliveries list and both audit feeds as `{ cached_at, value }` under `v25.cache.*`,
  and `OfflineBanner` NAMES the timestamp, because "₱48,200 in transit" means nothing
  without knowing when it was true. Order history is neither: no age limit, in
  `receiptHistory.js`.
- **Only the UNFILTERED read is cached** (`loadWithCache(..., { cacheable })`). Every
  one of those screens has filters; caching per combination would fragment the copy
  into whichever slice was last looked at. Offline, the same filters are re-applied to
  the held copy client-side (`filterInventoryRows`/`filterActivityRows` in
  `AuditPage.jsx`, `filterDeliveries` in `IncomingPage.jsx`). Tickets went further and
  fetches all statuses, filtering the tab on the client.
- **A stock/price conflict is a QUESTION, not a refused record** — `reconcile.js`
  (`v25.reconcile.*`), never the outbox's `needs_attention` list. That list is for
  records the server refused: one side is wrong and the fix is to re-point and resend.
  Here nothing is wrong, both numbers are honest counts, and the answer is not in the
  app. Answering one ENQUEUES a fresh ordinary write; it never patches a half-sent
  record. `StockReconcileModal.jsx` offers mine / theirs / **a third value I just
  counted**, and the prompt lives on the Inventory page (flag-independent) rather than
  in `OfflineMarker` (which returns null without `V25_OFFLINE_CORE`).
- **A conflict is another HUMAN's edit, not the server's number moving.** Stock moves
  all day on its own — every dispatch deducts, every delivery adds. `findCompetingEdit`
  in `productMutations.js` looks for an `inventory_audit_logs` row with `action_type`
  `manual_adjustment` on `current_stock` (or `price_change` on `base_wholesale_price`)
  dated after the record was queued. Widening that to "the value changed" would fire on
  every sale and teach the owners to tap through the modal without reading it.
- **But business movement is RE-DERIVED, not ignored** (`stockDriftSinceQueued` in
  `productMutations.js`). Not-a-conflict never meant not-a-problem: resending a count
  as an absolute value erased whatever sale or delivery had landed while it waited. The
  screening pass sums the `current_stock` audit deltas dated after the record was
  queued and sends `counted + drift`, so a stocktake queued at 09:00 no longer wipes a
  09:30 sale. It returns `null` — meaning "ask a person" — for the two cases it cannot
  prove: a full 50-entry audit page whose every stock row is newer than the record
  (movements may have fallen off the end), and a human `manual_adjustment` after the
  queue time that `findCompetingEdit` missed because other movements netted the server
  back to this device's baseline. Those become a conflict carrying
  `cause: CAUSE_UNEXPLAINED_MOVEMENT`, which `StockReconcileModal.jsx` words
  differently — it must not claim another tablet counted the shelf when none did.
  **Price is never re-derived**: a price does not move on its own, and "price plus a
  delta" is not a meaningful thing to send.
- **`delivery_edit`, not `manual_adjustment`, for a delivery edit/void's stock
  reversal** (`incoming.js`, migration 038). It is business activity; logging it under
  the human action type made the guard above raise a reconciliation question about a
  number nobody disputed. Any NEW `action_type` must be added to migration 011's CHECK
  constraint (via a new migration) and to the label maps in `AuditPage.jsx` and
  `ProductDetailPanel.jsx`.
- **`screenProductMutations()` runs BEFORE every drain** (`offline/index.js`), and no
  guarded record is ever sent unscreened — with no line it returns `{offline:true}` and
  changes nothing. A conflicting field is lifted OUT of its record (stripped from the
  PATCH body, or dropped from the batch's `updates`) so the rest of the same edit still
  lands; a record left carrying nothing is removed.
- **Product DELETE is online-only**, alone among §6's "full CRUD" — captain carve-out
  recorded in the ADR §6. Two valid counts have a reconciliation path; "deleted" vs
  "mid-sale on it" has no second value to weigh. Same gate as customer merge/delete
  (§7), delivery edit/void (§8), ticket resolve and every personnel mutation (§9), all
  via `DangerZoneDelete`'s `disabled`/`disabledReason` or a `title` tooltip.
- **Deliveries are the second table on the idempotency mechanism.**
  `<person><device letter>-DEL-<seq>` (`issueDeliveryRef`, its OWN counter —
  `v25.deliverySequence`), stored on
  `supplier_deliveries.receipt_station/receipt_device/receipt_sequence` (migrations 036
  and 040) plus `request_key` (migration 039) — same column names as `orders` on purpose,
  so `lib/idempotency.js` needs one whitelist entry. Without it a resent record is a
  second truckload of stock in the ledger.
- **Queued rows are merged into three lists now**, all the same `local-<outboxId>`
  shape G29 established: customers (`queuedCustomersFromOutbox`), products
  (`queuedProductsFromOutbox`) and deliveries (`queuedDeliveriesFromOutbox` +
  `mergeDeliveries`, deduped by delivery ref). A merged row is excluded from anything
  needing a server id — batch price selection, opening a detail panel.
- **Saving a custom price is offline-capable in ONE of its two entry points.** The
  *"Save Custom Price?"* prompt at the end of a sale (`persistPriceSave` in
  `OrderCreateModal.jsx`) enqueues; the Customers module's standalone *Add Custom Price*
  (`handleSetPrice` in `CustomerDetailPanel.jsx`) is a bare `api.post` and fails blind, as
  do that panel's price list and its product picker. Do not read ADR 0015 §7 as covering
  both — it used to claim that, and the claim was false. Open work, criterion 8.4.
- **Before filing an offline bug, read the Known Gaps table** at the end of
  [docs/offline-accessibility-acceptance-criteria.md](docs/offline-accessibility-acceptance-criteria.md).
  Several places where the app and the criteria disagree are deliberate and captain-parked
  (all of Personnel's edit form, delivery edits, ticket creation), and two cosmetic gaps are
  already acknowledged. That table, not this file, is the running list.
- **Ticket creation has no offline path** and that is deliberate: no ADR decision grants
  it one, unlike order/customer/delivery creation which are each explicitly
  additive-and-safe. It is blocked with an explanation, never left to fail as a fetch
  error.
- **§6's "full CRUD" has four locked fields, not just DELETE** — and they come from the
  captain's acceptance criteria, which are MORE SPECIFIC than the ADR prose for Inventory:
  [docs/offline-accessibility-acceptance-criteria.md](docs/offline-accessibility-acceptance-criteria.md)
  §7. `units_per_case` (7.4), `requires_bottle_return` + its `deposit_fee` (7.3) and
  `is_active` (7.8) are disabled offline on **both** `ProductFormModal` and
  `ProductDetailPanel`. The reason they are not reconcilable like a stock count:
  `units_per_case` is an input to the GENERATED `order_items.line_total`, the
  bottle-return flag decides whether the deposit ledger applies at all, and `is_active`
  decides what every other tablet can sell — none has a second honest value for
  `StockReconcileModal` to offer. `is_active` follows the same rule on Customers (8.5).
  **Always validate an Inventory change against §7 of that doc, not the ADR alone.**
- **`CustomerDetailPanel.handleSave`, `ProductDetailPanel.handleSaveDetails` and
  `PersonnelDetailPanel.handleSave` all diff the save payload against the loaded
  snapshot (`snapshot` state on Customers; `product`/`person` themselves on Products/
  Personnel) — only a field that actually changed is sent, for both online and offline
  saves.** This is what makes the four locked fields above (and 8.5's/9.2's
  `is_active`) true beyond their own carve-out: without it, ANY untouched field resent
  from a stale cached snapshot — not just the disabled ones — silently overwrites
  whatever another tablet wrote to that field while this one was offline (item 4,
  `data/leyble-hub-offline-multidevice-clobber-audit/report.md`, fixed 2026-09-02). The
  explicit `mutationsBlocked`/`sharedMutationsBlocked` deletions for the locked fields
  stay as belt-and-braces — the diff alone already drops them since their controls are
  disabled and so never change — but the diff is what protects every other field
  (name/category/unit/sku on Products; name/type/address/phone/notes on Customers;
  full_name/remarks/phone/license_number on Personnel). Server routes already treat an
  omitted field as "leave unchanged," so this is client-only; don't reintroduce a
  full-form patch when touching any of these `handleSave`s.
- **"Waiting to sync" has two sources, not one — on Inventory, Customers, and now
  Personnel too (G3, closed 2026-09-02).** `queuedProductsFromOutbox`/
  `queuedCustomersFromOutbox`/`queuedPersonnelFromOutbox` cover a row CREATED blind (no
  server row, merged in as `local-<outboxId>`); `pendingProductEditIds()`/
  `pendingCustomerEditIds()`/`pendingPersonnelEditIds()` (all in `client/src/offline/`)
  cover an existing row carrying an undrained EDIT (`product_update`/
  `product_batch_price`/the two `*_confirm` types for products; `customer_update` for
  customers; `personnel_update` for personnel — one entity type each, simpler than the
  product side). The EDIT half is the one that hides: `applyLocalProductPatch`/the
  customer and personnel equivalents write the operator's new value onto the held
  catalogue copy, so a blind edit renders identically to a saved one. Every badge reads
  the outbox directly, so it clears itself on drain with no extra wiring.
- **Personnel's offline carve-out is narrower than Customers': toggle AND photo AND
  delete all stay online-only (rules 9.0/9.1/9.2, ADR 0015 §9), where Customers only
  locks the toggle plus merge/delete.** `PersonnelDetailPanel.jsx`'s `mutationsBlocked`
  still gates the active/inactive checkbox, the ID photo upload button, and
  `DangerZoneDelete` — only the rest of the edit form and `PersonnelFormModal.jsx`'s
  *+ Add Personnel* moved onto the outbox (`updatePersonnelLocalFirst`,
  `client/src/offline/queuedPersonnel.js`). Before 2026-08-29 → 2026-09-02, one shared
  `mutationsBlocked` gated the whole form instead — see ADR 0015 §9's amendment note and
  `docs/offline-accessibility-acceptance-criteria.md` items 9.2/9.3 and Known Gaps G3.

### V3.5 Pocket — phone-responsive layout (see [docs/product/proposals/phone-responsive-layout.md](docs/product/proposals/phone-responsive-layout.md))

Piece 1 (order creation: orientation unlock, bottom-sheet cart, horizontal category
scroll) and Piece 2 (D5 — every other screen's table becomes cards at phone width)
both ship as additive `lg:` breakpoint gates, never a rewrite of the tablet/desktop
markup (D2). Piece 2's card block for a screen renders as a `lg:hidden` sibling placed
**before** the existing table in the JSX, which is then given `hidden lg:table`; every
row/container `data-testid` is duplicated onto the card unchanged, since the only
assertions against those particular testids in `e2e/appium/tests/*.test.mjs` are
count-inequality (`>0`, `===0`) or click-the-first-match, both indifferent to a doubled
DOM count as long as the visible (phone-width) copy sorts first.
**Exception — a testid whose exact text is read via WebDriver's `getText()`
(`tickets-status-badge`, `audit-action-badge`) must NOT be duplicated**: `getText()`
returns `""` for a `display:none` element, so a hidden table-row copy carrying the same
testid makes the Appium assertion fail on a phone-width emulator. For those two, the
testid lives only on the card's badge; the table's original badge is left rendering
the same content with no testid at all.

Piece 3 (V3.5 Pocket polish — captain-reviewed fixes on top of Pieces 1/2: Orders'
Drafts card, Dashboard's whole-card tap target, order creation's personnel picker
removed, Inventory/Customers header overflow menus, Inventory's category scroll +
segmented stock filter, the compact "Show inactive" switch) follows the same
additive-`lg:`-gate rule. **Overflow-menu positioning gotcha:** a phone-width "⋮" menu
button placed at the *left* edge of a header (before the primary action button, as in
`InventoryPage.jsx`/`CustomersPage.jsx`) must anchor its dropdown with `absolute
left-0`, not `right-0` — `right-0` aligns the dropdown's right edge to its own narrow
`relative` wrapper (just the button), which pushes most of the menu off-screen to the
left. Caught by checking `getBoundingClientRect()` in a real ~390px-wide iframe, not by
screenshot alone (a `role="menu"` rendered mostly off-canvas can still look like a
blank white box in a screenshot rather than visibly wrong).

Testing this against the Appium suite locally requires the debug APK to actually reach
the host machine's dev backend: `client/.env.production`'s `VITE_API_URL` outranks
`client/.env.local` under `vite build` (mode defaults to `production`), so
`VITE_API_URL=http://10.0.2.2:3000 npm run android:sync` (env var on the command line,
not just in `.env.local`) is what actually bakes the emulator's host-loopback alias
into the bundle — `e2e/appium/README.md` doesn't call this out.

### Accessibility (non-negotiable)
- Minimum 48×48px touch targets
- 16px+ fonts
- Visible labels above inputs — no placeholder-as-label
- `:focus-visible` ring on all interactive elements
- Status always conveyed with text + color, never color alone

---

## Module build status

| Module | Status | Notes |
|---|---|---|
| Inventory | ✅ Done | Category chips + stock filter |
| Customers | ✅ Done | Wholesaler custom pricing panel (separate delivery/pickup price tabs), order history |
| Personnel | ✅ Done | ID image upload, order history |
| Outgoing Orders | ✅ Done | Delivery + pickup types; editable at all statuses (inventory auto-reconciles, incl. Edit/Cancel inside the batch-review queues); price adjustment field; per-bottle deposit + bottle-return close flow (Review Deliveries queue); 80mm thermal receipt |
| Incoming Supplies | ✅ Done | Log deliveries, auto-restock; supports 0.5-case quantities |
| Tickets | ✅ Done | Create, view, resolve |
| Audit Log | ✅ Done | Read-only, filterable. Two append-only sources: `inventory_audit_logs` (stock deltas, `GET /api/v1/audit`) and `activity_logs` (cross-entity change log for orders/customers/products/personnel/tickets, `GET /api/v1/audit/activity`) |

> **Order totals:** an order's stored `total_amount` is **goods-only (qty × price) while it is open**; the bottle deposit on un-returned bottles is folded into the total only when the order is closed and returns are counted (`recomputeTotal` in [server/src/routes/orders.js](server/src/routes/orders.js)). This is intentional — pre-close totals deliberately exclude the refundable deposit.

---

## Schema — what diverges from the archived spec

The archived [docs/archive/SPECIFICATION.md](docs/archive/SPECIFICATION.md) predates migrations 012–026 (the divergences are listed below). Trust the actual migrations over the spec. For the current schema written up from the migrations, see [docs/architecture/DATABASE.md](docs/architecture/DATABASE.md).

| What the spec says | What the DB actually has |
|---|---|
| `products.base_retail_price` exists | **Dropped** (migration 012); wholesale-only model |
| `products` has no case-size field | `units_per_case INT NOT NULL DEFAULT 1` added (migration 012) |
| `order_items.quantity INT` | **`NUMERIC(10,2)`** (migration 013) — supports partial cases |
| `inventory_audit_logs.delta INT` | **`NUMERIC`** (migration 014) |
| `customers.customer_type IN ('retail','wholesale','suki')` | **`IN ('regular','wholesaler','discounted','markup')`** (migrations 015, 025, 031, 032, 034); default `'regular'`. It is a **descriptive tag only** — it carries no pricing logic ([ADR 0009](docs/adr/0009-custom-pricing-derived-from-saved-prices.md)) |
| `orders.driver_id`, `orders.helper_id` FK columns | **Dropped** (migration 016); replaced by `order_personnel` join table |
| `personnel.role_label VARCHAR(100)` | **Renamed to `remarks TEXT`** (migration 017) |
| `orders` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 018) |
| `orders` has no adjustment | `adjustment NUMERIC(10,2) DEFAULT 0`, `adjustment_reason TEXT` (migration 019) |
| `customer_product_prices` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 020) — append-only, existing rows default to 'delivery' |
| `products.current_stock INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case stock levels |
| `supplier_delivery_items.quantity_received INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case deliveries |
| `products` has no bottle-return flag | `requires_bottle_return BOOLEAN NOT NULL DEFAULT FALSE` added (migration 023). NB: per-bottle deposit amount lives in the pre-existing `products.deposit_fee` (migration 002) |
| `order_items` has no case-size / return fields | `units_per_case INT NOT NULL DEFAULT 1` and `bottles_returned INT NOT NULL DEFAULT 0` added (migration 023) |
| `order_items.line_total = quantity*(unit_price+unit_deposit_fee)` | **Reformulated** (migration 023) to `quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee`; still a `GENERATED ... STORED` column. Defaults (`units_per_case=1, bottles_returned=0`) reproduce the old result |
| no system-wide change log | `activity_logs` table added (migration 024) — append-only; `entity_type IN ('order','customer','product','personnel','ticket')`, `entity_id`, `action`, `summary`, `performed_by`, `created_at`. Written via [server/src/lib/activityLog.js](server/src/lib/activityLog.js) |
| `customer_product_prices.custom_deposit_fee` exists | **Dropped** (migration 026); deposit is now product-level (`products.deposit_fee`) with per-line override (`order_items.unit_deposit_fee`), not per-customer |
| no device/station concept, receipt number = row id | `stations` table + `orders.receipt_station`/`receipt_sequence` and the `GENERATED` `orders.receipt_number` added (migration 033). Partial unique index on the pair; historical rows keep NULL and are never backfilled |
| no device/person identity behind a receipt number | `users.receipt_person` (the permanent person number) and the `user_devices` table (one row per person-and-device pair, holding that pair's `device_letter`) added (migration 043) |
| no session concept on `users` | `session_id` / `session_device` / `session_started_at` added (migration 044) — ADR 0017 #8's one session per account; all nullable, and a token with no `sid` claim is still accepted |
| receipt number has no device letter | `orders.receipt_device` + `supplier_deliveries.receipt_device` added and both `GENERATED` display columns rebuilt over them (migration 040) — ADR 0017's `1A-00042`. Both partial unique indexes rebuilt with the letter `COALESCE`d **inside the index expression**, which is what keeps them protecting pre-letter rows |
| `stations` has no slot concept | `slot_number` (CHECK 1–3, partial UNIQUE), `slot_assigned_at`, `slot_assigned_by` added (migration 037) — ADR 0016's three fixed slots, now **dead columns**: [ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md) removed the slot concept and nothing reads or writes them. `activity_logs.entity_type` widened to accept `'station'` in the same migration, which is still live — that is where a device-letter allocation is recorded |
| `supplier_deliveries` has no device identity | Same `receipt_station`/`receipt_device`/`receipt_sequence` triple + partial unique index, and a `GENERATED` `delivery_ref` (`1A-DEL-00007`) added (migrations 036, 040) — deliberately the same column names so `server/src/lib/idempotency.js` covers both tables (ADR 0015 §8, ADR 0017 #14) |

### `order_personnel` join table (migration 016)
```sql
CREATE TABLE order_personnel (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  personnel_id INT NOT NULL REFERENCES personnel(id),
  role         VARCHAR(50) NOT NULL DEFAULT 'Driver'
);
```
Query pattern for personnel on an order:
```sql
SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
FROM order_personnel op JOIN personnel per ON per.id = op.personnel_id
WHERE op.order_id = $1
```

---

## Receipt printing

- Printer: **80mm thermal** (was 58mm until June 2026 — keep all sizing 80mm from now on)
- Implementation: receipt HTML built in [client/src/pages/orders/receiptTemplate.js](client/src/pages/orders/receiptTemplate.js),
  printed via `usePrintReceipt()` (used by OrderDetailPage and ReviewQueueModal)
- Uses `@page { size: 80mm auto; margin: 0 }`, body width 72mm — no external CSS needed
- Item layout: SKU on line 1 (with product name fallback), `qty unit × price → amount` on line 2
- Shows **DELIVERY RECEIPT** or **PICKUP RECEIPT** depending on `order.order_type`
- Footer: terms text (left) + "Received the above merchandise…" + `By:` signature line (right)
- Business name on receipt: **LEYBLE GENERAL MERCHANDISE** (not "Leyble Hub")
- **`Sold by: <name>` under the number** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md) #10),
  from `orders.created_by` (migration 042) surfaced as `sold_by_name`. It is the exit ramp the ADR
  names: once the seller is on the paper in words, the person digit leading the receipt number is an
  optional convenience. Nothing is backfilled — an order without one prints no line, and the ESC/POS
  copy in [escposReceipt.js](client/src/pages/orders/escposReceipt.js) must always say the same thing
  as the HTML one. A blind save stamps the name from the stored session, because the paper comes out
  seconds after Save and possibly days before the line is back.

---

## Deployment — Android app + cloud API

There is no on-prem/Windows computer, and **no web client**. The product ships only as an
**Android APK** (Capacitor wrap of the React app) talking to a **cloud-hosted** API + DB. The
backend is **API-only** — it does not serve a website; opening the Render URL in a browser
returns a 404 JSON. The Android APK is the only way in.
- **API:** Express on **Render** (repo root, `node server/src/index.js`), API-only (no
  `client/dist` served) — see [server/src/index.js](server/src/index.js).
- **Database:** **Supabase** managed Postgres (pooled `DATABASE_URL`).
- `npm run dev` (separate Vite + Express servers) is **dev-only** — local development still runs
  in a browser, which is why the cookie auth path is kept (see Security rules).
- Login: **one account per person** — `alvin@leyblestore.com`, `josie@leyblestore.com`,
  `luis@leyblestore.com`, all on the same password (`ACCOUNT_PASSWORD`, default `leyble123`),
  activated by the one-off `node server/db/setup-accounts.js`. The JWT is the whole identity:
  no profile picker, no `X-Active-Profile`, and `activity_logs.performed_by` is whoever signed
  in ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md) §5/§6, migration 041).
  Shared password and no password reset are accepted gaps, not oversights — attribution is
  honour-system, exactly as the picker it replaces was. `users.role` authorizes nothing.
- **One session per account** ([ADR 0017](docs/adr/0017-receipt-numbers-keyed-to-user-accounts.md)
  #8, migration 044). Login mints `users.session_id` and signs it into the JWT as `sid`;
  `requireAuth` refuses a token whose `sid` no longer matches, with `code:
  'session_superseded'`, and also refuses any token for a deactivated account. It is
  **never load-bearing for receipt uniqueness** — a takeover is a server-side act an
  offline tablet cannot hear, so uniqueness comes from the device letter alone — and it
  must never cost a device the receipts it is holding. A token with **no `sid` is
  accepted**: every pre-slice-5 token has none and tablets update one at a time over
  several days (ADR 0017 #13). `requireAuth` fails **open** if the database read itself
  errors; a DB hiccup must not sign the whole store out.
- **Bearer beats the cookie** in `requireAuth`. One browser cookie can only ever name one
  account, so a device holding a remembered account's own token has to be able to speak as
  that account explicitly. On the web dev tier `api/client.js` also drops the cookie
  (`credentials: 'omit'`) when it names someone other than the active account, rather than
  filing one person's sale under another's name.
- Full build & automated Play Store deploy steps: **[docs/operations/android.md](docs/operations/android.md)**.

### Database environments & deployment

- **Production:** Supabase PostgreSQL (Sydney). Render `leyble-hub-api` auto-deploys from `main` on push.
- **Development database:** Separate Supabase PostgreSQL (Tokyo), full replica set up 2026-08-25. Local dev points exclusively to development (never production); see [docs/operations/development-database.md](docs/operations/development-database.md).
- **Google Play Store (Internal Testing):** Android app builds and deploys automatically via GitHub Actions on push to `main` (modifying `client/**` or `.github/workflows/deploy-play.yml`). Tablet users receive background updates automatically through the Play Store.
- **V3.0 release sequencing:** Migrations deploy early and alone to production; server code and Android APK land together on release day ([ADR 0014](docs/adr/0014-v3-release-sequencing.md)).

> Because there is no web client, **every UI change requires rebuilding + reinstalling the APK**
> on each device — there is no web fallback to push fixes instantly.

---

## Git rules

> **CRITICAL — read before every commit/push.**

- **`main` branch (Production) is strictly guarded:**
  - **Never push or merge directly to `main` without Alvin's explicit go-ahead.** A push to `main` triggers immediate production deployments (Render API) and automated Google Play Store builds.
  - Always present completed work and ask *"ready to commit and push to main?"* — wait for a direct *"yes"* or *"okay, commit and push."*
- **Working branches (`dev`, `staging`, feature/task branches, worktrees):**
  - **Autonomous commit & push permitted:** Agents and Firstmate orchestration are free to commit, create branches, and push to non-`main` branches as needed for PRs, CI, and slice development without halting for confirmation.

## Security rules
- **Native Android (production):** the Capacitor app stores the JWT in `@capacitor/preferences`
  (native, app-sandboxed — *not* browser localStorage) and sends it as `Authorization: Bearer`.
  This is how the live app authenticates; see [docs/operations/android.md](docs/operations/android.md).
- **Local browser dev only:** `npm run dev` runs in a browser, where the JWT is set as an
  HTTP-only, SameSite=Strict cookie (never localStorage, never log the token). This path exists
  solely so login works during local dev — production serves no web client.
- `requireAuth` accepts both cookie and Bearer, and **Bearer wins** (ADR 0017 #7).
- `server/.env` must never be committed or exposed — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`
- All API routes require `requireAuth` middleware except `POST /api/v1/auth/login`
- Parameterized queries only — no string interpolation into SQL

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
