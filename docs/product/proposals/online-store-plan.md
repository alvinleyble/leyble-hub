# Proposal: Customer-Facing Online Store

**Status:** grilled, decisions locked — not built yet. Target: a new, separate repo (frontend
only), talking to an extended Leyble Hub API.
**Origin:** Alvin, 2026-07-31 grilling session.
**See also:** [PRD.md](../PRD.md) non-goals (this proposal deliberately reverses
"not customer-facing"), [DATABASE.md](../../architecture/DATABASE.md),
[ARCHITECTURE.md](../../architecture/ARCHITECTURE.md),
[order-lifecycle.md](../../architecture/order-lifecycle.md).

## The idea

A new customer-facing website (separate repo, mobile-friendly PWA) that lets Leyble's own
customers place order requests themselves — an *additional* channel alongside phone/in-person
ordering, not a replacement. Deliberately more restrictive than the admin app: **whole cases
only, no 0.5-case quantities.** Today customers are trained to order however they want (including
0.5-case and mixed-flavor workarounds staff absorb manually); this channel is meant to train them
toward simpler, bookkeeping-friendly ordering going forward.

## Non-goal reversal, flagged

Current docs (`PRD.md`, `README.md`, `AI_CONTEXT.md`, `docs/archive/SPECIFICATION.md`) all
explicitly state Leyble Hub is "not customer-facing," with "no public storefront, no customer
logins" named as a non-goal. This proposal reverses that. When this actually gets greenlit for
build, the PRD's non-goals section needs a matching update — noted here so it isn't missed later.

## Key architectural decision: one backend, no new database

Leyble Hub's Postgres DB stays the **single source of truth** for products, customers, pricing,
and orders. The new repo is a **frontend-only** client (mobile-friendly website/PWA) — no database
or backend of its own. Leyble Hub's existing Express API grows a new customer-facing surface (new
endpoints, new tables, new columns) alongside its existing staff-only routes. This falls out of
every decision below: accounts, pricing, catalog, and order history all live in/come from Leyble
Hub, so a second backend/DB in the new repo would just be a proxy with no payoff.

Practically: the "different repo" holds the *storefront UI* only. Leyble Hub's own repo (this one)
will need a follow-up implementation effort to add the endpoints/schema below, whenever this gets
built — the two repos ship on different schedules, but share one backend and one database.

## Decisions (from the 2026-07-31 grilling session)

1. **Integration model — request queue, not auto-committed.** An online order lands in a
   pending-review state; nothing is deducted from stock or assigned to personnel until a staff
   member confirms it in the admin app. Keeps a human checkpoint on every online order, same trust
   boundary as a phone order today.

2. **Customer accounts live in Leyble Hub, phone + OTP.** New `customer_accounts` table (phone
   number as identifier, SMS one-time-code login — no passwords, no email, since `customers` has
   neither today). Each account links to a `customers.id`.

3. **Signup linking: auto-link on exact phone match, else pending approval.** If the phone matches
   exactly one existing `customers.phone`, link immediately. If it matches zero or more than one,
   the account sits in `pending_approval` — browsable, but can't submit an order until staff links
   it to the right existing customer or creates a new one.
   - **Caveat surfaced during grilling: `customers.phone` is empty for essentially all existing
     records today.** Auto-link will fail open into "pending approval" for almost everyone at
     launch unless phone numbers are backfilled first.
   - **Action item: backfill `customers.phone` for existing customers before/at launch**, or
     auto-link will barely ever fire.

4. **Customers see their real effective price**, including wholesaler custom pricing (delivery
   vs. pickup rates from `customer_product_prices`) — not just `base_wholesale_price` for
   everyone. Requires moving price resolution (today client-side only, in `OrderCreateModal.jsx`'s
   `priceFor()`) into a shared server-side endpoint, so the admin app and the storefront resolve
   prices identically without duplicating the logic.

5. **Both delivery and pickup, customer picks upfront** — same as `order_type` today, since it
   changes which price list applies and whether an address is needed.

6. **Whole case per SKU, no mixed-flavor assortments.** Each flavor/variant stays its own product
   row; online quantity must be a whole number of cases of that SKU. A customer wanting 3 flavors
   adds 3 line items, one full case each — no "build an assorted case" concept. This is the
   deliberate training mechanism the whole proposal is built around.
   - Enforced at the **application layer only**, for the online path specifically —
     `order_items.quantity` stays `NUMERIC(10,2)` (unchanged) since the admin app still needs
     0.5-case support; the new customer-facing order-submission endpoint just validates quantity
     as a positive integer.

7. **No live stock numbers shown online.** Availability isn't surfaced as a number, and nothing is
   reserved between browsing and staff confirmation anyway. Instead: a new **manual
   `available_online` boolean** on `products`, independent of the numeric `current_stock`, so
   staff can pull an item from the storefront (out of stock, not ready, etc.) without exposing
   real inventory counts.

8. **New products default to hidden online** (`available_online` defaults `false`) — staff opts
   each product in explicitly, keeping the online catalog fully curated rather than
   auto-exposing something half-configured the moment it's created.

9. **No hard minimum-order or delivery-area rules at launch.** Any request can be submitted; staff
   reject/adjust/call the customer during review if it's too small, too far, or otherwise doesn't
   make sense. Revisit once real usage patterns exist.

10. **Cash/COD only — no online payment collection.** Matches the existing business model and the
    project's standing "no payment processing" non-goal; payment still happens in person/on
    delivery, same as today.

11. **Staff are alerted via a new in-app queue, not SMS/push.** A new "Online Requests" tab/queue
    in the existing admin app (same pattern as the Drafts or Review Deliveries queues), with an
    unread-count badge. No new alerting infrastructure (no SMS gateway, no push/FCM setup) needed.

12. **Customers see status in-app only — no SMS/push.** Order status (pending review → confirmed
    → out for delivery/ready for pickup → done, or rejected with a reason) updates in their
    storefront account; they check back rather than being pushed a notification. Keeps v1 free of
    any new messaging infrastructure or per-message cost.

13. **Customers can edit or cancel their own request freely, right up until staff acts on it.**
    Nothing is committed (no stock/personnel) at that stage, so this is low-risk self-service, same
    as editing a cart before checkout.

14. **Platform: mobile-friendly website / PWA, not an installable APK.** Reaches any phone
    (Android or iPhone) with zero install friction and no app-store review cycle, and — unlike
    Leyble Hub's APK — ships instantly without a rebuild/reinstall cycle per change. Matters more
    here since this is a customer-facing product that will iterate.

15. **Customers see their own order history and can reorder from a past order.** The new
    customer-facing API scopes `orders`/`order_items` reads to "orders belonging to my linked
    `customer_id`" — same underlying data Leyble Hub already tracks, just newly exposed to the
    customer who placed it.

16. **One backend, no new database** (see architecture section above) — the new repo is
    frontend-only; Leyble Hub's existing API/DB is extended, not duplicated.

## What this means for Leyble Hub's own repo (follow-up work, not done yet)

None of this is being built now — this file is the plan. When it's time to build, Leyble Hub's own
backend will need:

- **New table** `customer_accounts` (phone, OTP hash/expiry, linked `customer_id` nullable,
  status `pending_approval` / `active`).
- **New column** `products.available_online BOOLEAN NOT NULL DEFAULT FALSE`.
- **New order source/state** to represent an online request pre-confirmation — e.g. an
  `orders.source` column (`'staff'` / `'online'`) plus a new pre-`pending` status (parallel to how
  `draft` already works) that staff "confirm" (→ `pending`, enters the normal lifecycle) or
  "reject" (→ `cancelled`, with a reason). Reuses all the existing line-item, pricing, and total
  machinery rather than inventing a parallel order representation.
- **New customer-facing endpoints** (e.g. under `/api/v1/storefront/*`): request-OTP, verify-OTP,
  browse catalog (with resolved effective price), submit/edit/cancel a request, list own order
  history.
- **New customer-scoped auth**: a JWT type distinct from staff `requireAuth`, asserting a
  `customer_accounts` identity plus its linked `customer_id` — kept separate from the existing
  staff/`users` auth path.
- **Staff-side UI additions** to the existing admin app: an "Online Requests" queue
  (confirm/reject, badge count), an `available_online` toggle on the product form, and a small
  "Pending Accounts" screen for approving unmatched signups.
- **Data prerequisite**: backfill `customers.phone` before launch (see decision 3).
- **Docs**: update `PRD.md`'s non-goals once this is actually greenlit for build (see "Non-goal
  reversal" above).

## Explicitly out of scope for v1 (per decisions above)

- Online payment processing.
- SMS/push notifications (staff or customer).
- Mixed-flavor/assorted-case ordering.
- Minimum order value or delivery-area gating.
- Native Android/iOS app packaging.
- A second backend/database for the storefront.
