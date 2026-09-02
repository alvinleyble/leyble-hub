# Leyble Hub — Phone-Responsive Layout (Portrait)

**Status:** Settled Design
**Date:** 2026-09-02
**Origin:** Captain review of an interactive HTML mockup (order creation + orders list), approved prior to this doc
**See also:** [V2.0 Proposal](v2-tablet-pos-overhaul.md), [V3.0 — POS Order Creation in V1](v3-0-pos-order-creation-in-v1.md), [ADR 0016 — Three Fixed Station Slots](../../adr/0016-three-fixed-station-slots.md), [AGENTS.md](../../../AGENTS.md) "Frontend patterns"

---

## 1. Executive Summary

Leyble Hub's Android build locks the whole app to landscape
(`android:screenOrientation="sensorLandscape"` on `MainActivity` in
[`client/android/app/src/main/AndroidManifest.xml`](../../../client/android/app/src/main/AndroidManifest.xml)),
and every screen — including order creation
([`OrderCreateModal.jsx`](../../../client/src/pages/orders/OrderCreateModal.jsx)) — is
laid out for a tablet-width viewport. That decision was made for one specific device
(the Honor Pad X8B, see [v2-tablet-pos-overhaul.md](v2-tablet-pos-overhaul.md)), but only
one of the three daily users actually holds a tablet. Of the three fixed station slots
([ADR 0016](../../adr/0016-three-fixed-station-slots.md)) — slot 1 Alvin, slot 2 Josie,
slot 3 Luis — only slot 2 (Josie) runs on a tablet. Slots 1 and 3 (Alvin/Admin and Luis)
already run the app on ordinary phones today, forced into the landscape-tablet layout it
was never designed for.

This proposal makes the whole app — viewing screens and order creation both — usable on
a phone held in portrait, while leaving Josie's tablet-landscape experience completely
unchanged. All decisions below were reviewed and approved by the captain against an
interactive HTML mockup of the two hardest patterns (order creation, and the orders
list) before this document was written; they are recorded here as settled, not proposed
for discussion.

### Three Standing Principles

1. **Nothing changes at tablet width.** Every rule below is additive, gated to
   narrow/phone-width viewports. Josie's screen is untouched pixel-for-pixel.
2. **CSS adapts, not native code.** The native layer stops picking an orientation; the
   web layer (already responsive-capable via Tailwind breakpoints) does the adapting,
   exactly as it already does for the `desktop:` sidebar breakpoint documented in this
   repo's `AGENTS.md`.
3. **This is a design doc, not an implementation task.** It records what changes and
   why. Exact per-screen card field lists, spacing values, and component code are
   implementation work for the ship task this proposal hands off to.

---

## 2. Settled Decisions

### D1 — Orientation Unlock: CSS Adapts, Not Native Device Detection [SETTLED]

* **Decision:** Change `android:screenOrientation="sensorLandscape"` on `MainActivity`
  in
  [`AndroidManifest.xml`](../../../client/android/app/src/main/AndroidManifest.xml)
  to allow free rotation (`unspecified` or `fullSensor`), rather than adding runtime
  device-type detection to force different orientations on different hardware.
* **Rationale:** Reliably detecting "is this a tablet or a phone" on Android is not
  robust — screen size, DPI, and reported orientation are proxies, not guarantees, and
  drift across manufacturers and OS versions. CSS is what should adapt to whatever
  size/orientation the OS actually reports, not the native layer pre-deciding it. This
  also means a device's behavior is graceful if it's the "wrong" form factor for its
  slot (e.g. Luis's phone), rather than depending on a native heuristic guessing right.
* **Accepted Cost:** Josie's tablet is now also free to rotate to portrait; nothing in
  this proposal makes tablet-portrait a designed state (D2 pins the tablet layout to
  wide/landscape viewports specifically, not to "tablet hardware" — see D2). If Josie's
  tablet is physically rotated to portrait, screens fall into the same phone-width rules
  as a real phone rather than a broken in-between tablet layout.

### D2 — Josie's Tablet Layout Is Byte-for-Byte Unchanged [SETTLED]

* **Decision:** The existing landscape, side-by-side product-grid + order-panel layout
  in [`OrderCreateModal.jsx`](../../../client/src/pages/orders/OrderCreateModal.jsx) /
  [`POSProductGrid.jsx`](../../../client/src/components/pos/POSProductGrid.jsx) stays
  exactly as it is today at wide/landscape viewports (`OrderCreateModal.jsx`'s existing
  `lg:grid-cols-[minmax(0,1fr)_26rem]` split, line 820, holds unchanged). Every change
  in this proposal is additive, gated to narrow/phone-width viewports only.
* **Rationale:** The tablet flow was purpose-built and captain-approved in
  [v2-tablet-pos-overhaul.md](v2-tablet-pos-overhaul.md) and re-hosted into V1 in
  [v3-0-pos-order-creation-in-v1.md](v3-0-pos-order-creation-in-v1.md). It works today.
  This proposal's whole mandate is to add phone support, not to touch what already
  works for Josie.
* **Accepted Cost:** None — this is a constraint, not a trade-off. Every subsequent
  decision (D3–D6) is written as an addition gated behind a narrow-viewport breakpoint,
  never a replacement of the existing markup.

### D3 — Order Creation on Phone Width: Bottom-Sheet Cart [SETTLED]

* **Decision:** On phone-width viewports (roughly 360–430px),
  [`OrderCreateModal.jsx`](../../../client/src/pages/orders/OrderCreateModal.jsx) /
  [`POSProductGrid.jsx`](../../../client/src/components/pos/POSProductGrid.jsx) present
  the product tile grid full-screen by default — search bar, category strip, product
  tiles. The order/cart panel (customer picker, delivery/pickup toggle, line items with
  steppers, notes, personnel, totals, Save/Reset) becomes a **bottom sheet**: collapsed
  by default to a bar showing item count and running total, expanding (tapped or
  dragged open) to cover most of the screen.
* **Rationale:** The tablet's side-by-side grid+panel layout (`lg:grid-cols-[...]`)
  cannot fit at phone width — today's markup already falls back to `grid-cols-1`
  (stacked) below the `lg` breakpoint, which pushes the entire order panel below the
  product grid and off-screen, requiring a scroll to reach the cart mid-order. A bottom
  sheet instead keeps the product grid the primary, always-visible surface while the
  cart stays one tap away — matching how the rest of the POS flow (steppers,
  press-and-hold, zero-prompt printing) is tuned for speed over completeness-on-screen.
* **Accepted Cost:** A new interaction pattern (drag/tap-to-expand sheet) not used
  anywhere else in the app today; it is scoped to this one screen at phone width only.

### D4 — Category Filter on Phone Width: Single-Row Horizontal Scroll [SETTLED]

* **Decision:** On phone-width viewports, the category pill strip in
  [`POSProductGrid.jsx`](../../../client/src/components/pos/POSProductGrid.jsx)
  (currently `flex flex-wrap`, wrapping into roughly 3 rows on tablet across the
  project's ~15 production categories) becomes a **single row that scrolls
  horizontally** instead of wrapping. Every category stays a single tap. Categories keep
  their current alphabetical sort on phone too, for consistency with the tablet — no
  most-used-first or other reordering is introduced.
* **Rationale:** Three wrapped rows of pills consume too much vertical space on a phone
  screen, where every pixel of height competes directly with the product grid below it.
  A dropdown was considered and rejected: it costs two taps per category switch (open,
  then pick) on a screen whose whole point is fast, repeated category switching while
  ringing up orders — the same speed argument that drove the tablet's tap-only pill
  design in the first place. A horizontal scroll strip keeps the one-tap property.
* **Accepted Cost:** A category near the end of the alphabetical list may require a
  horizontal swipe to reach on phone width, versus being visible in one of three rows on
  tablet. Accepted in exchange for keeping every category one tap away and the sort
  order consistent across form factors.

### D5 — Every Other Screen: Tables Become Cards on Phone Width [SETTLED]

* **Decision:** Dashboard, Orders, Inventory, Customers, Personnel, Tickets, Audit, and
  Devices all follow one default pattern at phone width: each table row becomes a card
  showing the 2–4 fields that matter most for that screen (for Orders: receipt number,
  customer, status, total — adapted sensibly per screen), tapping through to the
  existing detail panel/drawer for the rest. Side panels and modals — the `fixed inset-0
  z-40` / `w-full max-w-lg` pattern already documented in this repo's `AGENTS.md` under
  "Frontend patterns" — already size to `w-full` and should mostly need only minor
  spacing/sizing tuning at phone width, not a structural redesign.
* **Rationale:** A dense multi-column table is the wrong shape for a ~375px-wide
  screen — columns either truncate illegibly or force horizontal scroll, which the
  existing table-based screens don't support today. A card per row, surfacing only the
  fields an owner actually scans for, keeps the list usable without inventing a new
  interaction pattern per screen; the detail panel that already exists for every one of
  these screens is where the rest of the data lives.
* **Scope note:** This proposal deliberately does **not** enumerate each screen's exact
  card fields, spacing, or breakpoints — that level of detail is implementation work for
  the ship task this proposal hands off to, not this doc. The one exception already
  called out above: Orders' card should lead with receipt number, customer, status, and
  total, since that mapping was reviewed directly against the captain-approved mockup.
* **Accepted Cost:** A card necessarily surfaces less at a glance than a table row with
  every column visible; the detail panel is one extra tap away for anything not in the
  2–4 headline fields. This is the standard cost of every table-to-card responsive
  pattern and was accepted as part of the mockup review.

### D6 — Three Fixed Station Slots: No Change Needed [SETTLED, Considered and Rejected]

* **Decision:** No change to
  [ADR 0016 — Three Fixed Station Slots](../../adr/0016-three-fixed-station-slots.md).
  This item is recorded explicitly so a future reader does not reopen it.
* **Rationale:** ADR 0016's slot system already works per-device, not per-form-factor —
  a phone is just another device that can hold a slot, exactly like a tablet. Luis's
  planned phone replacement (expected later in 2026) already goes through the existing
  device-reassignment flow on the `/devices` screen
  (`POST /stations/slots/:slot/assign` in
  [`server/src/routes/stations.js`](../../../server/src/routes/stations.js)). Nothing
  about a device being a phone versus a tablet touches slot assignment, receipt
  numbering, or the idempotency/offline machinery built on top of it.
* **Accepted Cost:** None — this is a non-change, recorded to close the question.

---

## 3. Component / File Pointer Table

| Area | File(s) | What changes at phone width |
| :--- | :--- | :--- |
| Orientation lock | [`client/android/app/src/main/AndroidManifest.xml`](../../../client/android/app/src/main/AndroidManifest.xml) | `MainActivity`'s `android:screenOrientation` moves from `sensorLandscape` to `unspecified`/`fullSensor` (D1) |
| Order creation — product grid | [`client/src/pages/orders/OrderCreateModal.jsx`](../../../client/src/pages/orders/OrderCreateModal.jsx), [`client/src/components/pos/POSProductGrid.jsx`](../../../client/src/components/pos/POSProductGrid.jsx) | Product grid becomes the default full-screen surface; existing `lg:grid-cols-[...]` split (line 820) stays as the wide-viewport case, untouched (D2, D3) |
| Order creation — cart panel | [`client/src/pages/orders/OrderCreateModal.jsx`](../../../client/src/pages/orders/OrderCreateModal.jsx) | Order panel (customer, type toggle, lines, notes, personnel, totals, Save/Reset) becomes a collapsible bottom sheet at phone width (D3) |
| Category filter | [`client/src/components/pos/POSProductGrid.jsx`](../../../client/src/components/pos/POSProductGrid.jsx) | `flex flex-wrap` pill container (line 143) gains a phone-width variant that scrolls horizontally in one row instead of wrapping; sort order unchanged (D4) |
| Dashboard, Orders, Inventory, Customers, Personnel, Tickets, Audit, Devices | respective `*Page.jsx` files under `client/src/pages/` | Table rows become cards at phone width, tapping through to the existing detail panel/drawer; exact fields per screen are implementation-time work (D5) |
| Side panels & modals | pattern documented in `AGENTS.md` "Frontend patterns" (e.g. [`PersonnelDetailPanel.jsx`](../../../client/src/pages/personnel/PersonnelDetailPanel.jsx), [`PersonnelFormModal.jsx`](../../../client/src/pages/personnel/PersonnelFormModal.jsx)) | Already `w-full` at phone width; expect minor spacing/sizing tuning only, no structural change (D5) |
| Station slots | [`server/src/routes/stations.js`](../../../server/src/routes/stations.js), `/devices` route (`StationsPage`) | No change — existing per-device reassignment flow already covers a phone replacing a tablet or another phone (D6) |

---

## 4. Explicit Non-Goals

1. **No native device-type detection.** Orientation is unlocked at the OS level; CSS
   breakpoints, not a runtime "is this a phone" check, decide layout (D1).
2. **No change to Josie's tablet-landscape experience.** Every rule above is additive
   and gated to narrow viewports (D2).
3. **No category dropdown or reordering.** Category filtering stays one-tap,
   alphabetically sorted, on every form factor (D4).
4. **No full enumeration of per-screen card fields.** That is implementation work for
   the ship task this proposal hands off to (D5).
5. **No change to the station-slot system.** A phone is just another device in the
   existing three-slot model (D6).
