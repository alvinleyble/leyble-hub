> 🗄️ **ARCHIVED — HISTORICAL SNAPSHOT.** This is a one-off bug/audit sweep of the Orders module
> taken in June 2026. It is not living documentation and was not kept up to date — some findings
> may already be fixed. For the current behaviour of orders see
> [Order Lifecycle](../architecture/order-lifecycle.md). Kept for historical reference.

---

# Orders Module — Audit Sweep Report

**Scope:** `client/src/pages/orders/` (all 5 files) + `server/src/routes/orders.js` + cross-cutting patterns vs. `customers.js`, `products.js`, `audit.js`.

---

## Pre-read: Intentional design (not bugs)

Two findings from the sweep needed correction against CLAUDE.md:

- **Deposit excluded from `total_amount` while open** — documented design. CLAUDE.md: "goods-only while open; deposit folded in only at close." Not a bug.
- **`base_wholesale_price` used for all customer types** — by design. Migration 012 dropped `base_retail_price`; the app is wholesale-only. Regular customers get the same base price as the starting point.
- **`setClauses` "SQL injection"** — the status endpoint builds `setClauses` from *hardcoded* SQL fragments (`dispatched_at = NOW()`, etc.), not from user input. `newStatus` is validated against an allowlist before the query. Not a real injection risk.

---

## Real Bugs

### Critical / High

**B1. `/adjustment` endpoint has no transaction** (`server/src/routes/orders.js` ~line 402)
The PATCH `/adjustment` does a bare `UPDATE orders SET ...` followed by `logActivity()`. If `logActivity` throws after the UPDATE commits, the adjustment is recorded but the audit entry is missing. Every other mutation endpoint uses `BEGIN/COMMIT/ROLLBACK`.

**B2. `bottles_returned` accepts values exceeding what was shipped** (`orders.js` `/close` endpoint ~line 547)
The `/close` handler accepts an `items` array with `bottles_returned` but never validates:
- `bottles_returned >= 0`
- `bottles_returned <= quantity * units_per_case`
- item IDs actually belong to this order

A user could record 999 bottles returned for a 1-case shipment, corrupting deposit math permanently.

**B3. Pickup stock deduction fails on non-linear status transitions** (`orders.js` ~line 470)
Stock is deducted only when `order.status === 'pending' && newStatus === 'completed'`. If a pickup order goes `pending → completed → in_transit → completed`, the second `completed` transition skips deduction because the prior status is now `in_transit`. Net result: stock never decreases.

**B4. `adjExpanded` re-opens on every data reload** (`OrderDetailPage.jsx` ~line 61)
```js
setAdjExpanded(Number(o.adjustment) !== 0);
```
This runs inside the `load()` callback triggered on every poll/refresh. If the user manually collapses the adjustment section, the next reload forces it back open whenever a nonzero adjustment exists.

**B5. `order_type` not validated in POST** (`orders.js` ~line 277)
Defaults to `'delivery'` but never checks the value is one of `['delivery','pickup']`. An invalid `order_type` passes through to the DB and may silently corrupt downstream logic.

---

### Low Priority

**B6. Rollback not explicit in `/close` catch block** (`orders.js` ~line 574)
The `finally` block releases the client but the `catch` never calls `ROLLBACK`. Implicit rollback on release is usually fine with node-postgres but is not guaranteed.

**B7. `returnCounts` dependency is fragile** (`OrderDetailPage.jsx` ~line 75)
```js
const bottleItemIds = bottleItems.map((i) => i.id).join(',');
// used as useEffect dep
```
This string changes whenever items are re-ordered from the API even if the set is identical, triggering unnecessary resets of the return count state.

**B8. No upper-bound for bottle return input** (`OrderCloseForm.jsx` line 89)
The input has `min="0"` but no `max`. Client should also prevent entry above `Math.floor(item.quantity * item.units_per_case)`.

**B9. `receiptNo` padding breaks for orders > 99999** (`OrderDetailPage.jsx` ~line 155)
`String(order.id).padStart(5, '0')` — `padStart` doesn't truncate; order 100000 becomes a 6-digit number.

**B10. Print dialog open failure is silent** (`OrderDetailPage.jsx` `handlePrint`)
`window.open()` returns `null` if blocked by a pop-up blocker. No user feedback shown.

---

## Inconsistencies (Orders vs. Other Modules)

**I1. `diffFields` not imported in `orders.js`**
Both `customers.js` and `products.js` import and use `diffFields()` from `../lib/activityLog` to generate structured diffs like `"Name changed from 'X' to 'Y'"`. `orders.js` only imports `logActivity` and builds manual `changeNotes` strings. Order edit audit entries are generic ("Items replaced (3 items)") while customer/product entries are field-level.

**I2. `unit_deposit_fee` never validated against product's `requires_bottle_return`**
`products.js` enforces: if `requires_bottle_return = false`, `deposit_fee` is forced to 0. `insertItems()` in `orders.js` accepts any `unit_deposit_fee` value without checking. An order could record deposit fees on products that don't require returns, or waive them on products that do, silently.

**I3. Item-level changes produce no audit detail**
When items are replaced via PATCH, the activity log records `"Items replaced (N items)"` only. No record of which products were removed or added, or what quantities/prices changed.

**I4. Bottle return amounts not logged per-item in `/close`**
The `closed` activity log says `"Bottle returns recorded for N items"` but not which items or how many bottles each.

**I5. `adjustment` fields possibly missing from list endpoint response** (`orders.js` ~line 251)
The `GET /orders` list omits `adjustment` and `adjustment_reason` from the SELECT. The list page uses these values — verify they're actually being returned or the client is silently getting `undefined`.

---

## Code Quality / Refactoring

**Q1. `bottleItems` filter duplicated 3× across files**
```js
order.items.filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0)
```
Same line in `OrderDetailPage.jsx`, `OrderCloseForm.jsx`, and `ReviewQueueModal.jsx`.

**Q2. `fmtDate` defined identically in two files**
`OrderDetailPage.jsx` and `ReviewQueueModal.jsx` both declare the same date formatter.

**Q3. Stock queries loop instead of batch** (`orders.js` `deductStock` / `restoreStock` ~line 126)
Each item triggers a separate `SELECT` + `UPDATE` on `products`. For large orders this is N×2 queries. Can use `WHERE product_id = ANY($1::int[])` to batch.

**Q4. Unnecessary `.map(String)` in `reconcileStock`** (`orders.js` ~line 195)
`Object.keys()` already returns strings — the `.map(String)` is a no-op.

**Q5. `recomputeTotal` uses two separate queries with a JS branch instead of a SQL CASE**
The function checks `ord.status === 'done'` in JS and fires one of two SQL queries. Can be a single query with a CASE expression.

---

## Idea Suggestions

**S1. Soft-confirm before stock-affecting status transitions**
Transitioning a delivery order to `in_transit` deducts stock invisibly. Show a short preview: "This will reduce stock for 3 products." before confirming.

**S2. Show "net deposit" at order level before close**
Show a running "Estimated deposit: ₱XX.XX (based on 0 returns)" line in the order total section for any order with bottle-return items so owners can see the worst-case total upfront.

**S3. Add a "bottles returned" column to the line-item table on OrderDetailPage after close**
Once an order is `done`, return counts are stored but only visible via deposit math. A `Returned` column next to `Qty` would make the record self-explanatory.

**S4. Highlight orders with adjustment in the orders list**
A small badge (e.g., `adj ±₱XX`) next to the total in `OrdersPage` would help owners spot discount/overcharge patterns at a glance.

**S5. Show who last changed an order's status in OrderDetailPage**
`activity_logs` stores `performed_by`. Surfacing "Last updated by: admin — Jun 9 2:30 PM" below the status badge would help owners when reviewing with staff.

---

## Recommended Enhancements

**E1. Max bottles returned validation (server + client)**
Server: validate `0 <= bottles_returned <= Math.floor(quantity * units_per_case)` in `/close`. Client: set `max` on return count inputs in `OrderCloseForm` and `ReviewQueueModal`.

**E2. Wrap `/adjustment` in a transaction**
Match the pattern of `/close`: use `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` around the UPDATE and `logActivity` call.

**E3. Add `order_type` enum validation in POST**
```js
if (order_type && !['delivery', 'pickup'].includes(order_type))
  return res.status(400).json({ error: 'Invalid order_type' });
```

**E4. Fix pickup stock deduction for non-linear transitions**
Add `stock_deducted BOOLEAN NOT NULL DEFAULT FALSE` to `orders`. Set it `true` when stock is first deducted, check it before deducting again, clear it on cancel/revert.

**E5. Import and use `diffFields` in orders.js**
Import from `../lib/activityLog`. Use it in the PATCH handler's `changeNotes` to match the audit quality of customers and products.

**E6. Validate `unit_deposit_fee` against product in `insertItems()`**
After fetching the product record:
- If `product.requires_bottle_return === false`, force `unit_deposit_fee = 0`
- If `product.requires_bottle_return === true` and none provided, default to `product.deposit_fee`

**E7. Batch stock queries in deductStock/restoreStock**
Replace the per-item query loop with a single `WHERE product_id = ANY($1::int[])` SELECT and batch UPDATEs.
