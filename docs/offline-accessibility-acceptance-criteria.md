# Offline Accessibility — Acceptance Criteria

Captain-authored acceptance criteria for Leyble Hub's full-app offline accessibility work
(Slice 3.1, merged to `dev` via PR #49; Slice 3.2, PR #50). The underlying architecture —
mutation boundaries, the offline outbox, and the eager-setup/incremental-sync model — lives in
[ADR 0015](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md); this document does
not restate it.

A coverage/correctness audit against the actual code (2026-08-28) found 7 open questions in this
list. The captain settled all 7 in a live interview the same day; each settled item below carries
a **"Settled 2026-08-28"** note. Everything else here is the criteria list as originally given,
unchanged.

> **Delivery note (updated 2026-08-29):** sections 4, 6, and 7–11 — full offline CRUD for
> products/stock, Incoming Supplies, customer profile edits beyond quick-create, and
> back-office read caching — shipped in
> [Slice 3.3](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md#downstream-delivery-slices).
> They are live behaviour to validate against, no longer scoped-but-not-yet-built. Sections
> 1.0 and 12.0 (offline login / resume after logout) shipped in Slice 3.1.

---

## Glossary

- **"Accessible"** = fully functional to view and loads the latest data for an online user, and
  loads saved local data for an offline user.
- **"o/o user"** = online/offline user (i.e. applies identically to both, except where noted).
- **"load up"** = online users get the latest server data; offline users get the last
  saved/synced local data.
- **Framing:** this is mainly about what OFFLINE users can/cannot do; online users always have
  full access.

---

## Criteria

1.0 User should be able to login offline if they have logged in once ever before.

> **Settled 2026-08-28:** keep a last-known-identity record across logout so a "Resume Offline
> Session" action becomes possible. Implementation is still pending — see
> [ADR 0015 §3](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md).
> *(captain decision: resume-offline-session-scope)*

1.1 If the user has never logged in before on this device, they must login online first; only then can they log in offline.

2.1 User can select a profile (**Josie, Luis, Admin** — "Alvin" is the existing "Admin" profile under a different display name, not a fourth profile) both online and offline.

> **Settled 2026-08-28:** "Alvin" is the existing Admin profile, not a new one. No new profile, no
> migration, no fourth roster entry. *(captain decision: alvin-profile-identity)*

2.2 User can switch profiles both online and offline, and switching applies its effect.

3.0 On a fresh app, after logging in per 1.0/1.1/2.1/2.2 while online, the app loads its data for the first time.

3.1 On a non-fresh app (user has logged in before) logging in again, the user sees the existing local app data.

4.0 Dashboard loads for online and offline users.

5.0 Outgoing orders load for online and offline users.

5.1 Outgoing-order purple "parked" drafts load for online and offline users.

5.2 Orders list loads for online and offline users.

5.3 Order search works for online and offline users.

5.4 All filters (possible duplicates, printed/not-printed, date filter) work for online and offline users.

5.5 Pagination works throughout for online and offline users.

5.6 Drafts tab is accessible and loads for online and offline users.

5.7 Pending / In Transit / Delivered / Closed / Cancelled tabs load for online and offline users.

5.8 Orders created locally on this device that have **not yet synced** to the server are editable offline: save changes, save custom price while editing, add adjustment, change quantity, change customer, search product, edit optional notes, reset/clear the order. Any order that has already synced to the server — which includes every pre-existing historical order — requires an online connection to edit its content, regardless of status.

> **Settled 2026-08-28:** offline content-editing (price, quantity, customer, adjustment, notes)
> is restricted to orders created locally that have never synced — never on an already-synced
> historical order, regardless of status. This mirrors ADR 0015 §5's existing rule for status
> transitions; see the new rule added there. *(captain decision: synced-order-edit-scope)*

5.9 Reviewing a Closed order offline: cannot reopen; shall be able to print; shall NOT be able to edit or add adjustment.

> **Settled 2026-08-28:** a Closed order is always synced when reviewed offline (Close is
> online-only, ADR 0015 §5), so it can never be edited offline — this item is corrected from "CAN
> edit, add adjustment" to match, matching the already-correct "cannot reopen" behavior.
> *(captain decision: synced-order-edit-scope)*

5.10 Reviewing a Delivered order offline: cannot Close / Back-to-In-Transit / Cancel; CAN edit, add adjustment, edit bottles returned, print receipt — **only while the order is still unsynced-local** (see 5.8). A Delivered order that has already synced requires an online connection to edit its content.

> **Settled 2026-08-28:** scoped by the same synced-order-edit-scope boundary as 5.8/5.9 — the
> "CAN edit" clause here was never wrong, it just needs the unsynced-local qualifier made
> explicit. *(captain decision: synced-order-edit-scope)*

5.11 Reviewing an In-Transit order offline: cannot Cancel / Mark-as-Delivered; CAN edit, add adjustment — **only while the order is still unsynced-local** (see 5.8). No print clause: Print Receipt stays hidden for In-Transit orders, online and offline alike.

> **Settled 2026-08-28:** two corrections. (a) same unsynced-local qualifier as 5.10. (b) the
> original "CAN print" clause is dropped — it was a drafting mistake; Print Receipt has always
> been hidden entirely for In-Transit orders regardless of connectivity, and that is not
> changing. *(captain decisions: synced-order-edit-scope, intransit-print-availability)*

5.12 Reviewing a Pending order offline: cannot start dispatch / cancel / Mark-as-Picked-up; CAN edit, print, add adjustment — **only while the order is still unsynced-local** (see 5.8). A Pending order that has already synced requires an online connection to edit its content.

> **Settled 2026-08-28:** scoped by the same synced-order-edit-scope boundary as 5.8–5.10.
> *(captain decision: synced-order-edit-scope)*

5.13 New Order Modal is fully functional for both online and offline: see all products, search all customers, both order types, all categories, select products, adjust quantities, change prices, add adjustment, optional notes, reset/clear, cancel, create, X-to-exit, save as draft, apply a regular customer's custom prices (discounted/wholesale/markup), save new custom prices for a customer.

5.14 In every order-list tab, offline users cannot bulk-select orders (since they can't act on them anyway).

6.0 Incoming Supplies: fully accessible online/offline except offline cannot delete a delivery (can edit).

7.0 Inventory: users can print the list.

7.1 Inventory: users can batch-edit product prices.

7.2 Inventory: offline users cannot delete a product.

7.3 Inventory: offline users cannot toggle "Requires Bottle Return".

7.4 Inventory: offline users cannot edit "Bottles Per Case".

> **Settled 2026-08-29 (Slice 3.3 review):** 7.3 and 7.4 apply on **both** product
> screens — Add Product and the product detail panel — and the per-bottle Deposit Fee
> follows the bottle-return flag it belongs to. A product can still be added blind
> (7.5); those fields simply keep their defaults until someone with a connection sets
> them. Disabled-with-a-message, and also withheld from the queued payload so a
> restated value cannot reverse another tablet's change on a field that has no
> reconciliation path. *(captain review: slice-3-3-inventory-gaps)*

7.5 Inventory: offline users CAN still freely add products; new offline-added products are treated as real immediately, exactly like offline-created customers and parked orders — no "private to this device until synced" staging.

> **Settled 2026-08-28:** dropped the "visible only to this device until synced" staging concept
> — no other offline-created entity in the app works that way, and adding a distinct staging
> model for products alone would be new, unneeded complexity.
> *(captain decision: offline-product-staging)*

7.6 Inventory: anything else not mentioned works normally for both.

7.7 Inventory: data loads up.

7.8 Inventory: the product active/inactive toggle is disabled offline with an explanatory message; the rest of the product edit form still saves normally offline.

> **Settled 2026-08-29 (captain, live):** the rule already written for Customers (8.5)
> and Personnel (9.2) applies identically to products, everywhere the toggle appears.
> *(captain review: slice-3-3-inventory-gaps)*

7.9 Inventory: a product carrying an unsynced change shows the same "Waiting to sync" affordance offline-created customers and orders already carry — both for a product added offline and for an offline edit to an already-synced product.

> **Settled 2026-08-29 (captain review):** 7.5's "treated as real immediately" needs a
> visible counterpart, or a blind edit looks identical to a saved one: the held copy
> already shows the operator's new number. Tapping a still-queued product answers with
> the reason its detail panel cannot open yet, the same answer the customer directory
> gives. *(captain review: slice-3-3-inventory-gaps)*

8.0 Customers: offline users can print the list.

8.1 Customers: offline users can search customers.

8.2 Customers: data loads up.

8.3 Customers: offline users can add a new customer.

8.4 Customers: offline users can fully edit a customer's details and set custom prices.

8.5 Customers: the active/inactive toggle is disabled offline with an explanatory message; the rest of the customer edit form still saves normally offline.

> **Settled 2026-08-28:** disabled-with-message, not a silent drop of `is_active` from the
> outboxed payload — matches the explanatory-badge pattern ADR 0015 already uses for other
> online-only actions. *(captain decision: active-toggle-ux)*

8.6 Customers: offline users cannot merge customers.

8.7 Customers: offline users cannot delete customers.

9.0 Personnel: offline users cannot delete personnel.

9.1 Personnel: offline users cannot upload or delete a photo.

9.2 Personnel: the active/inactive toggle is disabled offline with an explanatory message; the rest of the personnel edit form still saves normally offline.

> **Settled 2026-08-28:** same rule as 8.5, applied to Personnel.
> *(captain decision: active-toggle-ux)*

9.3 Personnel: anything else not mentioned is accessible offline.

10.0 Tickets: offline users cannot Resolve a ticket.

10.1 Tickets: anything else not mentioned is accessible offline.

11.0 Audit log should "align accordingly": offline-queued actions simply appear in the Audit Log once they sync — eventual consistency only, no synthesized "pending sync" placeholder rows.

> **Settled 2026-08-28:** no synthesized "⏳ pending sync" rows. Offline-queued actions appear
> once the outbox drains them and the same route handlers log them, same as an online action —
> nothing else changes. *(captain decision: audit-log-pending-rows)*

12.0 Logout: user can log out, and can log back in offline if they have local data of a previously-logged-in account on that device.

> **Settled 2026-08-28:** requires the same last-known-identity record as 1.0 — see ADR 0015 §3.
> Implementation is still pending. *(captain decision: resume-offline-session-scope)*
