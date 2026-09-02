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
> Everything in this list is **live behaviour to validate against** except the four items
> named below. Shipped: Slice 3.1 (PR #49), Slice 3.2 (PR #50), the audit follow-ups
> (PRs #53, #54 — including offline login / Resume Offline Session, items 1.0 and 12.0),
> Slice 3.3 (PR #55 — offline product/stock CRUD, Incoming Supplies, customer profile
> edits, back-office read caching) and the drafts regression fix (PR #56 — items 5.1, 5.6,
> 5.13 for this device's own drafts). Per-PR detail is in
> [ADR 0015 § Delivery Slices](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md#delivery-slices--what-actually-shipped).
>
> **Genuinely still open:**
> 1. **5.15, historical draft orders** — settled 2026-08-29, scoped but not yet built
>    (`leyble-hub-offline-historical-drafts-edit`). See 5.15 and Known Gaps G2.
> 2. **Deferred conflicts** where this document and the shipped app disagree on purpose —
>    9.2/9.3 (Personnel), 6.0 (delivery edit), 10.1 (ticket creation). See Known Gaps.
> 3. **One minor UX gap** observed testing PR #55, captain-acknowledged and non-blocking.
>    See Known Gaps G7.
>
> **Closed 2026-09-02:** 8.4's custom-price half — custom-price capture is now online-only
> by design everywhere (Customers module and New Order modal alike), not a gap. See 8.4,
> 5.13, and Known Gaps G1 (closed). Also closed: G6's Inventory offline-banner reconnect
> observation, verified by static review + new unit coverage — see Known Gaps G6 (closed).

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
>
> **One exception, added 2026-08-29:** a synced **draft** order is not covered by this rule —
> see 5.15. Everything else in 5.8 stands.

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

5.15 A **synced/historical draft order** can be opened, edited, and moved forward into a real
order while offline — the one exception to 5.8's rule that a synced order needs a connection to
edit. Discarding stays narrower: only a draft created in the **same offline session on this
device** can be discarded offline; a historical/synced draft can never be deleted or discarded
offline.

> **Settled 2026-08-29 (captain, live) — SCOPED BUT NOT YET BUILT.** A draft is not yet an
> order: no stock has moved, nothing has printed, and nothing downstream depends on it, so
> advancing one carries none of the multi-device hazard that keeps synced orders online-only
> in 5.8. Deleting one is a different act — it destroys a row other devices can see, the
> shape of a merge or a void — so it keeps the stricter, session-local boundary.
>
> **Current behaviour (do not test against the rule above yet):** only drafts this device
> parked itself are editable offline (`_local: true` in `parkedOrders.js`; PR #56).
> Server-sourced drafts are cached whole so 5.1 and 5.6 still *list* them blind, but opening
> one offline answers *"Offline — this draft is on the server and needs a connection to
> open."* and discarding one answers the same. Closing this is a queued, not-yet-dispatched
> backlog item (`leyble-hub-offline-historical-drafts-edit`).
> See [ADR 0015 §5](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md).
> *(captain decision: historical-draft-offline-edit-scope)*

6.0 Incoming Supplies: fully accessible online/offline except offline cannot delete a delivery (can edit).

> **⚠ Conflict flagged 2026-08-29 — not silently resolved.** The shipped app blocks
> **editing** an already-logged delivery offline as well as deleting it:
> `DeliveryDetailPanel.jsx` gates both on one `mutationsBlocked`, and only *logging a new
> truck* works blind. That follows
> [ADR 0015 §8](adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md), whose
> chosen option reads "Voids and line edits remain online-only" — editing a logged delivery
> reconciles stock movements it already made, which is the same hazard as a void. So the
> code and the ADR agree against this item's "(can edit)" clause. Needs a captain call:
> either this clause is dropped, or §8 grants delivery edits an offline path. Listed as
> Known Gaps G4.

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

10.1 Tickets: anything else not mentioned is accessible offline.

> **⚠ Flagged 2026-08-29:** the shipped app also blocks **creating** a ticket offline
> (`TicketsPage.jsx`, *"Needs a connection — new tickets can't be raised offline"*), which
> this item reads against. The reasoning applied in Slice 3.3: no decision in ADR 0015
> grants ticket creation an offline path, unlike order / customer / delivery creation, each
> of which is explicitly established as additive-and-safe — so it is blocked with an
> explanation rather than left to fail as a fetch error. That is an implementer's reading,
> not a captain decision; recorded here rather than silently absorbed. Viewing tickets and
> their detail panels offline works as this item intends. Known Gaps G5.

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
| G2 | Historical (synced) drafts not editable offline | Open work | 5.15 | Scoped 2026-08-29, backlog item `leyble-hub-offline-historical-drafts-edit` |
| G3 | Personnel edit form blocked entirely offline, not just toggle + photo | Deferred conflict | 9.2, 9.3 vs ADR §9 | Captain: *"let it be for now"* (2026-08-29) |
| G4 | Editing a logged delivery is blocked offline, not only deleting | Open conflict | 6.0 vs ADR §8 + code | Needs a captain call |
| G5 | Creating a ticket is blocked offline | Open conflict | 10.1 vs code | Implementer's reading; needs confirmation |
| G6 | Inventory offline banner may not clear promptly on reconnect | Closed — verified by static review + test | 7.7 | Closed 2026-09-02: see detail below |
| G7 | No "Waiting to sync" indicator on an offline-edited customer row | Observation | 8.4, 8.5 | Cosmetic inconsistency, non-blocking |

**G3 — Personnel.** Full detail under item 9.2. The captain has seen this and parked it
because the Personnel module is not in use; do not change either the ADR or the app without a
fresh decision.

**G4 — Delivery edits.** Full detail under item 6.0. Code and ADR §8 agree with each other and
against criterion 6.0's "(can edit)" clause. Deliberately not resolved by rewriting either
side.

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
queues and syncs correctly, but the customer's row in the directory shows nothing to say so.
Inventory got both halves of this affordance in PR #55 — `queuedProductsFromOutbox` badges
products *created* blind, and `pendingProductEditIds()` badges existing products carrying an
undrained *edit*. Customers only has the first half (`queuedCustomersFromOutbox`, the
`local-<outboxId>` rows), so an edit to an already-synced customer is invisible. An
inconsistency between two screens, not a functional failure. Captain-acknowledged,
non-blocking; a natural companion to G1 whenever someone is next in that panel.
