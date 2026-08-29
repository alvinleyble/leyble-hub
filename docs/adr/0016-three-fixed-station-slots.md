# Three Fixed Station Slots, Captain-Reassignable

**Status:** Settled (2026-08-29)
**Origin:** Captain decision, 2026-08-29 (receipt-number format grill)
**See also:** [ADR 0003: Device-Issued Receipt Numbers](0003-device-issued-receipt-numbers.md), [ADR 0004: Local-First POS](0004-local-first-pos.md), [ADR 0006: Receipt Number as Idempotency Key](0006-receipt-number-as-idempotency-key.md), [ADR 0010: Receipt Number Addresses an Order Across the Sync Boundary](0010-receipt-number-addresses-order-across-sync-boundary.md), [ADR 0011: Only the Android App is a Station](0011-tablets-as-stations-browser-as-dev-tier.md)

## Context

A receipt number is `<station>-<sequence>`. [ADR 0003](0003-device-issued-receipt-numbers.md)
set `<station>` as an integer each device claims once at install from
`station_number_seq` (migration 033), on a rule of "numbers only creep upward, never
reused". That gave two properties nobody wants to lose — the number is known on the
device with no round trip, and it is unique across devices without coordination — and
one nobody chose:

- **The station component is unbounded.** Whatever hardware registers next takes the
  next number. A wipe, a reinstall, a fresh browser profile, a new git worktree all
  count as new devices. The development database climbed past station 78 in four days
  of testing, and production is at 8 registrations for a three-tablet store.
- **A replaced tablet loses its numbering.** The replacement registers as a stranger
  and starts a brand-new number space, so the person it replaced sees their receipts
  jump from `2-00417` to `9-00001` with nothing connecting the two.

The captain confirmed the operational fact that makes a bounded scheme safe here: this
store runs **exactly three physical tablets, strictly one per person** — Alvin, Josie,
Luis — never shared, never swapped between people. That is a fixed fact about this
deployment, not a general product assumption.

This reopens part of ADR 0003's rejection of "Option D: reusing the active user profile
as the number space". It reopens only the *bounded set* half of it, and for this
deployment shape only. **Option D itself stays rejected**: the number is still not the
profile. Profiles switch on one tablet mid-shift and the same profile can drive several
devices, so keying receipts on the profile would still put two devices in one number
space. What changes is where an available number comes from — from "the next value of a
sequence, forever" to "one of three fixed slots, assigned to a device".

## Decision

1. **Three slots, permanently.** `<station>` is one of `1`, `2`, `3` — slot 1 is Alvin's
   tablet, 2 is Josie's, 3 is Luis's. Nothing else is issuable. The owner mapping is a
   constant in [`server/src/lib/stationSlots.js`](../../server/src/lib/stationSlots.js)
   because it is the decision, not data the owners edit; which physical device holds
   each slot is data, and lives in `stations.slot_number` (migration 037).
2. **The server assigns, the device stores.** `POST /stations/register` hands a device
   the lowest free slot, so an ordinary three-tablet install needs no admin action. A
   fourth device is answered `slot_number: null` — it registers, it just cannot issue
   receipts — instead of being given a number 4.
3. **Slots are reassignable, and that is the device-replacement mechanism.**
   `POST /stations/slots/:slot/assign` moves a slot onto another device, releasing the
   previous holder in the same transaction. It is reachable from the Devices screen
   (`/devices`, V1 back-office UI), either on the new tablet ("use this tablet") or
   from another tablet by picking the new device out of the unassigned list. Every
   assignment is written to `activity_logs` as an `station` / `slot_assigned` entry.
4. **Reassignment continues the numbering.** The registration/assignment response
   carries `next_sequence` and `next_delivery_sequence`; the client seeds its local
   counters from them and **never downwards**, so a replacement picks up past what the
   old tablet printed rather than restarting at `00001`, and a tablet holding
   undrained receipts keeps its own, higher counter.
5. **A replacement is seeded past a reserve gap.** The outgoing tablet may hold receipts
   it issued and never synced; those numbers are invisible to the server. The
   replacement therefore starts at the server's high-water mark plus `REASSIGN_RESERVE`
   (50). A gap in a device's numbering is invisible; a repeat is two customers holding
   the same receipt number, and — because the receipt number is the idempotency key
   ([ADR 0006](0006-receipt-number-as-idempotency-key.md)) — would make each new order
   answered with the old order stored under that number.
6. **A backstop in the write path.** `POST /orders` and `POST /incoming` refuse a
   receipt number or delivery reference whose station is outside 1–3
   (`assertIssuableStation`). This is what makes "no order created from here on shows a
   station above 3" true of the stored row rather than merely of the current client: a
   tablet still running a pre-0016 build carries a number it claimed under the old
   scheme. Reads are untouched — `parseReceiptNumber` stays format-only, so historical
   values still parse for display and lookup.
7. **The server is authoritative on who holds a slot.** Registration re-confirms on
   every app start, and every 10 minutes on a device left running, rather than
   short-circuiting on what is stored. A tablet whose slot was moved to its replacement
   is told, clears its stored number and stops issuing. A registration that simply does
   not answer changes nothing: the stored slot is kept and the tablet carries on blind.
8. **No backfill.** The ~1,300 legacy `#<id>`-only orders and every order already
   created under the old uncapped station numbers keep their numbers unchanged
   (extending ADR 0003 #6 and ADR 0010 #4). `stations.station_number` and its sequence
   are left in place too — it is now the registry's internal id for a device, and is
   never the receipt station.

## Why this does not reopen the risk ADR 0003 was avoiding

ADR 0003's fear was two devices sharing one number space, producing colliding receipt
numbers that only surface on paper in a customer's hand — and, since ADR 0006, colliding
idempotency keys that silently swallow an order. Every property that ruled that out
still holds:

- **Exactly one authoritative claim per slot.** The uniqueness that used to come from a
  Postgres sequence now comes from the partial unique index
  `stations_slot_number_uniq`, and reassignment releases and claims in one transaction.
  Two devices cannot both hold slot 2, and the claim path takes `FOR UPDATE` on the
  current holders so two simultaneous registrations cannot both take slot 1.
- **Still locally issued.** Nothing about issuance changed: `issueReceiptNumber()` reads
  the stored number and the stored counter, with no network call, online or offline
  ([ADR 0004](0004-local-first-pos.md)).
- **Still idempotent.** The receipt number is unchanged in shape and role
  ([ADR 0006](0006-receipt-number-as-idempotency-key.md)), and still addresses the order
  across the sync boundary before any round trip
  ([ADR 0010](0010-receipt-number-addresses-order-across-sync-boundary.md)).
- **Still not chosen by hand on the device.** ADR 0003's "one careless tap" objection was
  to a device picking its own number in a free-for-all. A slot is assigned by one
  server-side statement, to one device, with the previous holder released in the same
  breath, and the act is logged.

The one risk this design adds is the invisible-undrained-receipt window on reassignment,
addressed by decision 5 (the reserve gap) and by the confirmation copy on the Devices
screen, which tells the operator to sync the outgoing tablet first.

## Considered Options

- **Option A: three fixed slots, server-assigned and captain-reassignable (Chosen).**
  Bounds the station component to what the store actually is, and makes device
  replacement a first-class two-tap action that preserves continuity.
- **Option B: leave ADR 0003 as-is (Rejected).** Correct in the general case and still
  the right default for a store whose device count is not known. Rejected here because
  the captain's actual pain — receipts showing station 9 in a three-tablet store, and a
  replaced tablet losing its series — is caused precisely by the unbounded allocation.
- **Option C: profile-keyed numbers, `JOSIE-00042` (Rejected, unchanged from ADR 0003).**
  Profiles identify people, not devices; they switch mid-shift and can drive several
  devices at once. It would reintroduce exactly the shared-number-space collision this
  ADR is careful to keep ruled out.
- **Option D: cap by validating on write only, leaving allocation alone (Rejected).**
  Refusing a station above 3 at `POST /orders` without changing the allocator would let
  a tablet issue and print numbers it can never sync — the worst possible place to
  discover the cap, on paper, after the customer has left.
- **Option E: let the operator type the slot number on the device (Rejected).** ADR
  0003's original objection stands: one careless tap puts two tablets in one number
  space. Assignment stays a single server-side statement over a unique index.

## Consequences

- Receipt numbers from here on read `1-…`, `2-…`, `3-…` and nothing else. Existing
  numbers are untouched and the two shapes coexist permanently, exactly as legacy
  `#<id>` orders already do.
- Production's eight test registrations hold no slots after this migration. The first
  three tablets to sign in claim 1, 2, 3 in that order — so **sign in on Alvin's tablet
  first, then Josie's, then Luis's**, or correct it afterwards on the Devices screen.
- A device that holds no slot cannot save an order at all: `issueReceiptNumber()` throws
  and the order modal surfaces "This tablet has not been given a station number yet."
  That is the intended state for a fourth device and for a replacement nobody has
  assigned yet.
- **Dev and CI are not special-cased, deliberately.** A fresh worktree, CI run, or
  browser profile registers as a new device and — once three devices hold the slots on
  that database — gets none, the same as a fourth tablet would. A developer takes a slot
  on the Devices screen, which is the same mechanism the captain uses and therefore the
  one that stays exercised. Adding a dev-only bypass was rejected on ADR 0011's Option C
  reasoning: a divergent code path leaves the real one untested.
