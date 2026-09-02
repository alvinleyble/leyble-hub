# Offline Accessibility — Acceptance Criteria

Captain-authored acceptance criteria for Leyble Hub's full-app offline accessibility work. The
underlying architecture — mutation boundaries, the offline outbox, and the eager-setup/
incremental-sync model — lives in
[ADR 0015](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md); this document does
not restate it.

A coverage/correctness audit against the actual code (2026-08-28) found 7 open questions in this
list. The captain settled all 7 in a live interview the same day; each settled item below carries
a **"Settled 2026-08-28"** note. Everything else here is the criteria list as originally given,
apart from the corrections dated 2026-08-29 and marked as such.

> **Delivery note (rewritten 2026-08-29 — what is live vs. what is still open).**
> Everything in this list is **live behaviour to validate against** except the item
> named below. Shipped: Slice 3.1 (PR #49), Slice 3.2 (PR #50), the audit follow-ups
> (PRs #53, #54 — including offline login / Resume Offline Session, items 1.0 and 12.0),
> Slice 3.3 (PR #55 — offline product/stock CRUD, Incoming Supplies, customer profile
> edits, back-office read caching), the drafts regression fix (PR #56 — items 5.1, 5.6,
> 5.13 for this device's own drafts) and the historical-drafts read-only fix (PR #64 —
> item 5.15). Per-PR detail is in
> [ADR 0015 § Delivery Slices](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md#delivery-slices--what-actually-shipped).
>
> **Genuinely still open:**
> 1. **One deferred conflict** where this document and the shipped app disagree on
>    purpose — 9.2/9.3 (Personnel). See Known Gaps G3.
>
> **Closed 2026-09-02:** 8.4's custom-price half — custom-price capture is now online-only
> by design everywhere (Customers module and New Order modal alike), not a gap. See 8.4,
> 5.13, and Known Gaps G1 (closed). Also closed the same day: G2 (5.15, historical draft
> orders — reversed to match 5.8's rule, no code change needed), G4 (6.0, delivery edit —
> doc corrected to match the app and ADR 0015 §8), G5 (10.1, ticket creation — doc corrected
> to state the exception explicitly), G6 (Inventory offline-banner reconnect observation,
> verified by static review + new unit coverage), and G7 (customer offline-edit sync badge,
> item 8.4/8.5 — `pendingCustomerEditIds()` added, mirroring the Inventory pattern). See
> Known Gaps for each.

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
> Session" action becomes possible. *(captain decision: resume-offline-session-scope)*
>
> **Shipped 2026-08-29 (PR #54):** `AuthContext.jsx` writes `v25.lastIdentity` beside
> `v25.session`; logout and a genuine 401 clear only the latter, so
> `getLastKnownIdentity()` / `resumeOfflineSession()` restore the operator with no server
> round trip, and `LoginPage.jsx` offers *"Resume Offline Session"* when that record
> exists. See [ADR 0015 §3](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md).

1.1 If the user has never logged in before on this device, they must login online first; only then can they log in offline.

2.1 User can select a profile (**Josie, Luis, Admin** — "Alvin" is the existing "Admin" profile under a different display name, not a fourth profile) both online and offline.

> **Settled 2026-08-28:** "Alvin" is the existing Admin profile, not a new one. No new profile, no
> migration, no fourth roster entry. *(captain decision: alvin-profile-identity)*

2.2 User can switch profiles both online and offline, and switching applies its effect.

3.0 On a fresh app, after logging in per 1.0/1.1/2.1/2.2 while online, the app loads its data for the first time.

3.1 On a non-fresh app (user has logged in before) logging in again, the user sees the existing local app data.

4.0 Dashboard loads for online and offline users.

5.0 Outgoing orders load for online and offline users.

5.1 Outgoing-order purple "parked" drafts load for online and offline users. *(Loading is
shipped, PR #56 — the list is the union of the last cached server drafts and this device's own
parked ones. What you can then DO with one depends on which half it came from: see 5.15.)*

5.2 Orders list loads for online and offline users.

5.3 Order search works for online and offline users.

5.4 All filters (possible duplicates, printed/not-printed, date filter) work for online and offline users.

5.5 Pagination works throughout for online and offline users.

5.6 Drafts tab is accessible and loads for online and offline users. *(Same split as 5.1 — see
5.15 for what is editable.)*

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

5.11 Reviewing an In-Transit order offline: CAN Mark-as-Delivered — this is one of the three
forward transitions the offline path exists to support — **only while the order is still
unsynced-local** (see 5.8); cannot Back-to-Pending or Cancel, since those reversals stay
online-only regardless of sync state. CAN edit, add adjustment — only while the order is still
unsynced-local (see 5.8). No print clause: Print Receipt stays hidden for In-Transit orders,
online and offline alike.

> **Settled 2026-08-28:** unsynced-local qualifier on edit/adjustment, and the original "CAN
> print" clause dropped — it was a drafting mistake; Print Receipt has always been hidden
> entirely for In-Transit orders regardless of connectivity, and that is not changing.
> *(captain decisions: synced-order-edit-scope, intransit-print-availability)*
>
> **Corrected 2026-09-02:** the prior wording — "cannot Cancel / Mark-as-Delivered" — read as a
> blanket prohibition on Mark-as-Delivered, which contradicts both ADR 0015 §5 and the shipped
> code (`posSave.js`'s `OFFLINE_TRANSITIONS`, ~line 367-374; `OrderDetailPage.jsx`'s "Mark as
> Delivered" control, ~line 747-760) — an unsynced-local In-Transit order can be marked
> delivered offline; that is one of the three explicitly-supported forward transitions. Only the
> actual reversal (Back to Pending, ~`OrderDetailPage.jsx` line 732-745) and Cancel are
> online-only, and stay so even for an unsynced-local order. Captain decision 2026-08-31 (this
> was a wording defect only; no code change): app behavior for this criterion was already
> correct. *(captain decision: offline-forward-transition-wording)*

5.12 Reviewing a Pending order offline: CAN Start Dispatch and Mark-as-Picked-Up — the other two
forward transitions the offline path exists to support — **only while the order is still
unsynced-local** (see 5.8); cannot Cancel, which stays online-only regardless of sync state. CAN
edit, print, add adjustment — only while the order is still unsynced-local (see 5.8). A Pending
order that has already synced requires an online connection to edit its content.

> **Settled 2026-08-28:** scoped by the same synced-order-edit-scope boundary as 5.8–5.10.
> *(captain decision: synced-order-edit-scope)*
>
> **Corrected 2026-09-02:** the prior wording — "cannot start dispatch / cancel /
> Mark-as-Picked-up" — read as a blanket prohibition on all three, which contradicts both ADR
> 0015 §5 and the shipped code (`posSave.js`'s `OFFLINE_TRANSITIONS`, ~line 367-374;
> `OrderDetailPage.jsx`'s "Start Dispatch" and "Mark as Picked Up" controls, ~line 698-730) — an
> unsynced-local Pending order can start dispatch or be marked picked up offline; those are two
> of the three explicitly-supported forward transitions. Only Cancel is online-only, and stays so
> even for an unsynced-local order. Captain decision 2026-08-31 (this was a wording defect only;
> no code change): app behavior for this criterion was already correct.
> *(captain decision: offline-forward-transition-wording)*

5.13 New Order Modal is fully functional for both online and offline: see all products, search all customers, both order types, all categories, select products, adjust quantities, change prices, add adjustment, optional notes, reset/clear, cancel, create, X-to-exit, save as draft, apply a regular customer's custom prices (discounted/wholesale/markup); the in-sale price override always works offline, but "save new custom prices for a customer" is online-only by design.

> **Corrected 2026-09-02 — the "save new custom prices" clause is online-only, everywhere.**
> The *"Save Custom Price?"* prompt is gated on connectivity in addition to its existing
> "customer already exists on the server" check, and silently never opens offline (no toast,
> no explanation needed — captain confirmed this UX choice 2026-08-31). This closes a
> two-tablet race: `customer_product_prices` has no unique constraint, so two offline
> tablets could each save a different price for the same customer/product and both would
> land with no signal to either operator about which one "won." The Customers module's own
> *Add Custom Price* is the same story — see 8.4 and Known Gaps G1 (closed). The order's own
> line-item price override for that one sale is unaffected and still works offline.

5.14 In every order-list tab, offline users cannot bulk-select orders (since they can't act on them anyway).

5.15 A **synced/historical draft order** follows the same rule as every other synced order
(criterion 5.8): it opens read-only offline and needs a connection to edit or advance it.
Discarding is likewise online-only for a synced/historical draft; only a draft created in the
**same offline session on this device** can be discarded offline.

> **Settled 2026-09-02 (captain, live) — reverses the 2026-08-29 exception.** The captain
> reversed the earlier decision to grant historical drafts an offline edit/advance path,
> specifically for consistency with how every other order status already behaves under 5.8 —
> a draft gets no special carve-out. This matches what's already shipped (PR #64): a
> historical (already-synced) draft opens read-only offline via `OrderDetailPage.jsx`
> (Edit Order, the adjustment toggle, and Cancel Order are hidden outright for
> `status === 'draft'`), the same as any other synced order. A session-local draft (parked
> entirely offline, never synced) is unaffected — it still opens, edits, and discards through
> `OrderCreateModal.jsx` with no network, exactly as before.
> See [ADR 0015 §5](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md).
> *(captain decision: historical-draft-offline-edit-scope)*

6.0 Incoming Supplies: fully accessible online/offline except offline cannot delete a delivery.

> **Confirmed 2026-09-02:** editing an already-logged delivery is online-only, same as
> deleting one. `DeliveryDetailPanel.jsx` gates both on one `mutationsBlocked`, and only
> *logging a new truck* works blind. That matches
> [ADR 0015 §8](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md), whose
> chosen option reads "Voids and line edits remain online-only" — editing a logged delivery
> reconciles stock movements it already made, which is the same hazard as a void. Doc
> corrected to match the app and the ADR. See Known Gaps G4 (closed).

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

8.4 Customers: offline users can fully edit a customer's details; custom prices are online-only everywhere, by design.

> **Corrected 2026-08-29, closed 2026-09-02.** The **details** half is live (Slice 3.3):
> `CustomerDetailPanel.jsx`'s Save routes through `updateCustomerLocalFirst`, queueing blind
> and toasting *"Saved on this device · will sync when connected."*
>
> The **custom-price** half is deliberately **online-only, everywhere** — not a gap, a closed
> decision. `customer_product_prices` is append-only with no unique constraint on
> customer/product/order_type, so two offline tablets could each set a different price for
> the same pair; both inserts would land with no signal to either operator about which one
> "won." The panel's *Add Custom Price* action (including its price list and product picker)
> is disabled with an explanatory message while offline, matching the disabled+message
> pattern already used in this panel for the active/inactive toggle, merge, and delete.
> `OrderCreateModal.jsx`'s *"Save Custom Price?"* prompt (5.13) is gated the same way —
> it silently never opens offline, even for a customer who already exists on the server.
> A cashier can still override a line-item price for that one sale while offline; only
> *remembering* it as the customer's new standing price waits for a connection. Known Gaps
> G1 is closed.

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
>
> **⚠ Conflict with ADR 0015 §9 — deliberately left standing (captain, 2026-08-29).**
> This item (with 9.3) says only the toggle and the photo are blocked offline and the rest
> of the personnel edit form still saves. **The shipped app blocks the whole form**, plus
> *+ Add Personnel*: `PersonnelPage.jsx` and `PersonnelDetailPanel.jsx` compute one
> `mutationsBlocked = fromCache || !checkIsOnline()` and disable Save, photo upload, delete
> and Add alike. PR #55 implemented
> [ADR 0015 §9](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md)
> ("personnel is read-only offline"), not this item. The captain was shown the conflict
> directly and chose to leave it: *"let it be for now, personnel module is not being used
> anyway."* **This is an acknowledged deferral, not an oversight or a bug to file** — a
> future reader should not rediscover it as a surprise, and neither side should be changed
> without a fresh captain decision. Known Gaps G3.

9.3 Personnel: anything else not mentioned is accessible offline. *(Read with 9.2's conflict
note — in the shipped app, "accessible" means viewable, not editable.)*

10.0 Tickets: offline users cannot Resolve a ticket.

10.1 Tickets: anything else not mentioned is accessible offline, with one exception —
creating a new ticket requires an online connection.

> **Confirmed 2026-09-02:** `TicketsPage.jsx` blocks **creating** a ticket offline
> (*"Needs a connection — new tickets can't be raised offline"*). No decision in ADR 0015
> grants ticket creation an offline path, unlike order / customer / delivery creation, each
> of which is explicitly established as additive-and-safe — so it is blocked with an
> explanation rather than left to fail as a fetch error. Viewing tickets and their detail
> panels offline works as this item intends. Doc corrected to state the exception
> explicitly. See Known Gaps G5 (closed).

11.0 Audit log should "align accordingly": offline-queued actions simply appear in the Audit Log once they sync — eventual consistency only, no synthesized "pending sync" placeholder rows.

> **Settled 2026-08-28:** no synthesized "⏳ pending sync" rows. Offline-queued actions appear
> once the outbox drains them and the same route handlers log them, same as an online action —
> nothing else changes. *(captain decision: audit-log-pending-rows)*

12.0 Logout: user can log out, and can log back in offline if they have local data of a previously-logged-in account on that device.

> **Settled 2026-08-28:** requires the same last-known-identity record as 1.0 — see ADR 0015 §3.
> *(captain decision: resume-offline-session-scope)*
>
> **Shipped 2026-08-29 (PR #54)**, with 1.0 and by the same mechanism.

---

## Known Gaps, Deferrals and Open Conflicts

*(Added 2026-08-29. One place to look before filing a bug or briefing a task: everything here
is already known. Each entry says whether it is **open work**, a **deferred conflict** the
captain has seen and parked, or an **observation** nobody has confirmed reproducible yet.
[ADR 0015](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md) points here from
its Delivery Slices section rather than duplicating the list.)*

| # | Item | Kind | Criteria | Status |
| :-- | :--- | :--- | :--- | :--- |
| G1 | Custom prices cannot be set offline, from the Customers module or the New Order modal | Closed — by design | 8.4, 5.13 | Closed 2026-09-02: online-only everywhere is the intended design, not a gap (no unique constraint on `customer_product_prices`) |
| G2 | Historical (synced) drafts not editable offline | Closed — reversed for consistency | 5.15 | Closed 2026-09-02: captain reversed the drafts exception for app-wide consistency; current app behavior (read-only offline) was already correct, no code change needed |
| G3 | Personnel edit form blocked entirely offline, not just toggle + photo | Deferred conflict | 9.2, 9.3 vs ADR §9 | Captain: *"let it be for now"* (2026-08-29) |
| G4 | Editing a logged delivery is blocked offline, not only deleting | Closed — doc corrected | 6.0 vs ADR §8 + code | Closed 2026-09-02: confirmed online-only 2026-09-02, doc corrected to match app + ADR 0015 §8 |
| G5 | Creating a ticket is blocked offline | Closed — doc corrected | 10.1 vs code | Closed 2026-09-02: confirmed online-only 2026-09-02, doc corrected to state the exception explicitly |
| G6 | Inventory offline banner may not clear promptly on reconnect | Closed — verified by static review + test | 7.7 | Closed 2026-09-02: see detail below |
| G7 | No "Waiting to sync" indicator on an offline-edited customer row | Closed — fixed | 8.4, 8.5 | Closed 2026-09-02: fixed 2026-09-02, `pendingCustomerEditIds()` added mirroring the Inventory pattern, badge now shows on an offline-edited customer row |

**G2 — Historical drafts.** Full detail under item 5.15. The captain settled this
2026-08-29 with an exception for synced drafts, then reversed it 2026-09-02 for consistency
with how every other order status already behaves under 5.8 — a synced/historical draft is
not a special case. The app's shipped behavior (PR #64, read-only offline) was already
correct under the reversed rule; only the doc needed correcting.

**G3 — Personnel.** Full detail under item 9.2. The captain has seen this and parked it
because the Personnel module is not in use; do not change either the ADR or the app without a
fresh decision.

**G4 — Delivery edits.** Full detail under item 6.0. Code and ADR §8 agree with each other;
the doc's stale "(can edit)" clause has been corrected to match both.

**G5 — Ticket creation.** Full detail under item 10.1.

**G6 — Inventory offline banner on reconnect.** Originally an unconfirmed observation from
PR #55 testing: after the tablet regained connectivity, the Inventory offline banner might not
visibly clear promptly. **Closed 2026-09-02** by a static/code-level re-verification pass plus
new unit coverage (no live device involved — see limitation below):

- Traced the full mechanism in `InventoryPage.jsx`. The banner (`OfflineBanner`) renders solely
  off `fromCache`. `load()` sets `fromCache` to `false` on a successful `GET /products` and to
  `true` only in the catch branch, when it falls back to the cached copy. The `online` and
  `leyble:drain-complete` listeners (lines ~76–85) both call `load(true)` — a silent retry of the
  live GET, not a mere UI toggle — so the banner clears exactly when, and only when, a live read
  actually succeeds again.
  - `online` fires on the browser network-interface event and re-tries the live fetch
    immediately; if the fetch still fails (interface up, server not yet reachable) `fromCache`
    stays `true` and the banner correctly stays up.
  - `leyble:drain-complete` (`drainNotifier.js`) only fires after a real successful send, so by
    the time it reaches `InventoryPage` connectivity is already confirmed and the follow-up
    `load(true)` reliably clears the banner.
- Added `client/test/inventory-reconnect-banner.test.mjs` (3 new unit tests, all passing as part
  of `cd client && npm test`): banner clears on `online` once the live GET succeeds, banner
  clears on `leyble:drain-complete` once the live GET succeeds, and — the negative case — the
  banner stays up if `online` fires but the live GET still fails (ruling out an optimistic clear
  on the browser event alone).

**Known limitation of this pass:** this is code-level + jsdom unit verification only; it does
not confirm real-device timing (e.g. how promptly Android's WebView actually fires `online`, or
end-to-end latency on a real reconnect). No functional gap was found — if the observation from
PR #55 recurs on a real device, that points at platform-level event timing, not at this
mechanism, and should be filed as a fresh, separately-reproduced item rather than reopening this
one from a single unconfirmed sighting.

**G7 — No sync indicator on an offline-edited customer.** Editing an existing customer offline
queued and synced correctly, but the customer's row in the directory showed nothing to say so.
Inventory got both halves of this affordance in PR #55 — `queuedProductsFromOutbox` badges
products *created* blind, and `pendingProductEditIds()` badges existing products carrying an
undrained *edit*. Customers only had the first half (`queuedCustomersFromOutbox`, the
`local-<outboxId>` rows). **Closed 2026-09-02:** `pendingCustomerEditIds()` was added to
`client/src/offline/queuedCustomers.js`, mirroring `pendingProductEditIds()`'s exact approach,
and wired into `CustomersPage.jsx`'s existing-row "⏳ Waiting to sync" badge condition
alongside `queuedCustomersFromOutbox()` — the same pattern `InventoryPage.jsx` already uses for
products.
