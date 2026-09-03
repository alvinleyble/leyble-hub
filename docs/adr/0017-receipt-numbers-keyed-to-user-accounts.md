# Receipt Numbers Keyed to User Accounts, With a Per-Person Device Letter

**Status:** Settled (2026-09-03)
**Origin:** Captain decision, 2026-09-03 (receipt-numbering grill session)
**Supersedes:** [ADR 0016: Three Fixed Station Slots](0016-three-fixed-station-slots.md)
**Revises:** [ADR 0006: The Receipt Number is the Anti-Duplicate Key for a Resent Record](0006-receipt-number-as-idempotency-key.md), on the single point of which value is the retry key
**See also:** [ADR 0003: Device-Issued Receipt Numbers](0003-device-issued-receipt-numbers.md), [ADR 0004: Local-First POS](0004-local-first-pos.md), [ADR 0010: Receipt Number Addresses an Order Across the Sync Boundary](0010-receipt-number-addresses-order-across-sync-boundary.md), [ADR 0011: Only the Android App is a Station](0011-tablets-as-stations-browser-as-dev-tier.md), [ADR 0014: V3.0 Release Sequencing](0014-v3-release-sequencing.md), [ADR 0015: Full-App Offline Accessibility and Mutation Boundaries](0015-full-app-offline-accessibility-and-mutation-boundaries.md), [docs/product/glossary.md](../product/glossary.md)

---

## Context

A receipt number is `<station>-<sequence>`, issued on the device at Save with no server round trip ([ADR 0003](0003-device-issued-receipt-numbers.md)).
[ADR 0016](0016-three-fixed-station-slots.md) bounded `<station>` to three fixed slots - 1 Alvin, 2 Josie, 3 Luis - assigned to devices by the server, reassignable from a Devices screen.

That scheme works, and the numbers it prints are the ones the captain wants to see.
What it costs is a mismatch between what the number means and what everybody reads it as.

- **The slot is assigned to hardware, but everybody reads it as a person.** Slot 1 means "Alvin's tablet", not "Alvin", and the whole store treats those as the same thing because today they are. The moment they stop being the same thing - a replacement device, a tablet borrowed for an afternoon - the number is quietly wrong and nothing on the receipt says so.
- **Keeping a person's series continuous through a hardware change needs machinery.** ADR 0016 decision 3 built a Devices screen, a slot-assignment endpoint and an `activity_logs` entry for it; decision 4 seeds the replacement's counter forward; decision 5 adds `REASSIGN_RESERVE` (50) as a gap, because the outgoing tablet may hold receipts it issued and never synced, and a repeat of one of those numbers would be answered by the idempotency key with the *old* order. That is three interlocking mechanisms and one admin screen, for a store of three people, all of it existing so that a number tied to hardware can survive the hardware.
- **Who sold it is not on the paper.** The number encodes a device. The seller is the active profile, which is recorded in `activity_logs.performed_by` and printed nowhere.

Two findings from the codebase made a different shape cheap enough to choose.

**The three profiles are already real `users` rows.**
`setup-profiles.js` tags existing `users` rows with a `profile_key`; each has its own id, and `activity_logs.performed_by` already points at those ids.
So removing profiles is not a data migration and does not muddy a single historical attribution: it is "give each of those existing rows its own email and password, and delete the impersonation header".

**`users.role` guards nothing.**
It is signed into the JWT in [`server/src/routes/auth.js`](../../server/src/routes/auth.js) and then read by no route guard and no client gate.
Every other `role` in the codebase is `order_personnel.role`, which is Driver or Helper.
This matters because [ADR 0015 section 3](0015-full-app-offline-accessibility-and-mutation-boundaries.md) rejected an offline operator picker on the grounds that it would bypass admin-versus-staff access control.
There is no such access control to bypass, and there never was, so that objection does not apply to this decision.

### Why commit `b1547ef` exists

`b1547ef`, "Revert 'Release: promote dev to main (receipt-number slots + offline-first V2.5 batch)' (#60)", carries no explanation but "This reverts commit ...".
The cause, recorded here so nobody has to ask again: **the work was merged into `main` when the captain had asked for it to be wrapped up to `dev`.**
The revert undid a wrong merge target.
It was not a rejection of the design, it was not a bug rollback, and it is not evidence that the feature failed.

---

## Decision

A receipt number is `<person><device letter>-<sequence>`, for example `1A-00042`.
The leading number identifies the person who sold it, the letter distinguishes that person's own devices, and the sequence counts within that person-and-device pair starting at `00001`.

1. **The person number is the user account, and it is permanent.**
   Alvin/admin is 1, Josie is 2, Luis is 3 - deliberately the same digits as today's slot assignments, so each person's series reads as continuing rather than restarting.
   A new hire takes the next number.
   A number is **never** reused, including after someone leaves: accounts are deactivated (`users.is_active`), never deleted, and their historical receipts must always still resolve.

2. **The device letter is allocated per person-and-device pair**, on the first successful *online* sign-in of that person on that device.
   Alvin's tablet is `1A`, his phone `1B`, his browser `1C`.
   The letter is deliberately **not** globally meaningful: the same physical tablet can be `1A` for Alvin and `2B` for Josie.
   Its only job is keeping one person's devices apart.

3. **A replacement device gets a fresh letter and never inherits one.**
   When Alvin's tablet dies, the replacement signs in and becomes `1D-00001`.
   This was chosen over inheriting `A` for two reasons.
   It needs no device list, no assignment UI and no admin action at all, just a sign-in.
   And a brand-new letter **cannot collide with receipts the dead tablet never synced**, so no high-water seeding and no reserve gap are needed.
   **ADR 0016's Devices screen, its slot-assignment endpoint, `REASSIGN_RESERVE` and the whole slot concept are removed.**
   The visible cost is that the letter changes; that is accepted, because the person number - which is what the captain cares about - stays stable.

4. **One series per person-and-device pair. No online/offline split.**
   An earlier proposal split each person's numbers into an online bucket (`1A-`) and an offline bucket (`1B-`), to keep risky numbers away from safe ones.
   Rejected; see [Considered Options](#considered-options) for the four reasons, which are load-bearing and must not be re-litigated informally.

5. **Profiles are deleted as a concept.**
   The `users.profile_key` column and the `X-Active-Profile` identity swap in [`server/src/middleware/auth.js`](../../server/src/middleware/auth.js) both go, along with `ProfileContext.jsx`, `ProfilePickerModal.jsx` and `GET /auth/profiles`.
   Because the three profiles are already real `users` rows carrying the ids that `activity_logs.performed_by` already references, no historical attribution is muddied and no data migration is required.

6. **Each person gets their own email and password.**
   `alvin@leyblestore.com`, `luis@leyblestore.com`, and one for Josie, replacing the single shared `josie@leyblestore.com` login plus profile pick.
   The first sign-in of a person on a given device requires a connection, exactly as [ADR 0015 section 2](0015-full-app-offline-accessibility-and-mutation-boundaries.md) already requires today.

7. **A device remembers accounts it has successfully signed in, and switching between them offline is two taps with no password.**
   This preserves what the profile picker did - Josie takes over Alvin's tablet mid-blackout and the receipt says Josie - without keeping a second concept to do it.
   The list is "accounts that have proven themselves on this tablet", not "people we know about".
   ADR 0015 section 3 rejected an offline picker because it would bypass admin-versus-staff access control; that reasoning no longer applies, because no such access control was ever built (see Context).

8. **One session per account is kept, but it is never load-bearing for receipt uniqueness.**
   What it can do: end an account's session on other devices when that account signs in somewhere new.
   What it cannot do: reach a device that is offline. A session takeover is a server-side act, so an offline device never hears it and keeps selling; it finds out on reconnect and is asked to sign in again.
   Receipt uniqueness comes from the letters alone, never from the session.
   **Hard requirement: a session takeover must never discard receipts waiting to sync.**
   Those are device state, not session state, and already survive logout per [ADR 0015 section 3](0015-full-app-offline-accessibility-and-mutation-boundaries.md); that must stay true.

9. **Split the retry key off the receipt number.**
   This revises [ADR 0006](0006-receipt-number-as-idempotency-key.md), whose Option B - a separate client-generated key per request - is now **accepted**.
   Its original rejection reasoning does not hold.
   An idempotency key and a receipt number are not two identities that can disagree: one labels the *sale*, the other labels the *attempt to send it*.
   And "a UUID means nothing to a human" is true and irrelevant, because retry keys are not for humans to read.
   The receipt number remains unique and remains the route identifier ([ADR 0010](0010-receipt-number-addresses-order-across-sync-boundary.md)), so a duplicate still matters; but the consequence of one drops from *a sale silently vanishing into an older order* to *two orders sharing a label and a lookup having to ask which one you meant*.
   This is the highest-value item in this decision.

10. **Print the seller's name on the receipt in words**, `Sold by: Luis`, alongside the number.
    Clearer than a digit, useful to the customer, and it is the exit ramp: once the name is printed, the person prefix becomes optional rather than load-bearing.

11. **Order search must accept bare digits.**
    Typing `42` returns every order whose sequence is 42 across all prefixes, as a short list showing customer name and date.
    Customers read digits off faded thermal paper and skip the prefix, and the number of parallel series grows over time.

12. **Nothing existing is touched, and three formats coexist permanently.**
    The roughly 1,300 legacy `#1240` orders, everything issued under today's `3-00061` slot scheme, and the new `3A-00001`.
    No backfill, extending [ADR 0003](0003-device-issued-receipt-numbers.md) #6, [ADR 0010](0010-receipt-number-addresses-order-across-sync-boundary.md) #4 and [ADR 0016](0016-three-fixed-station-slots.md) #8.
    **Never sort or order by receipt number.**
    As text those three shapes sort as nonsense; every list, export and report orders by time.

13. **Switchover ordering.**
    There is a multi-day window while tablets are updated one at a time, during which some devices still hold unsynced receipts in the old format.
    The full procedure is recorded in [ADR 0014](0014-v3-release-sequencing.md); in short: deploy a server that accepts **both** formats first and change nothing visible, wait until every tablet reports no waiting receipts, then update tablets one at a time, and **never remove old-format acceptance**.
    Separately, `assertIssuableStation` in [`server/src/lib/stationSlots.js`](../../server/src/lib/stationSlots.js), which refuses any station outside 1-3, must be widened before a fourth person is ever created, or that person's first sale is rejected.

14. **Delivery references take the same shape and the same rules.**
    `1-DEL-00007` ([ADR 0015 section 8](0015-full-app-offline-accessibility-and-mutation-boundaries.md)) becomes `1A-DEL-00007`, with the same person number, the same per-person device letter, the same no-backfill rule and the same both-formats-accepted switchover.

---

## Considered Options

- **Option A: person number plus a per-person device letter, allocated on first online sign-in (Chosen).**
  Puts the seller in the number, which is how everyone already reads it, and gets device uniqueness from a letter that costs one column and one sign-in.
  Device replacement stops being an admin action entirely.

- **Option B: keep ADR 0016's three fixed device slots (Rejected).**
  It solved the unbounded-station-number problem correctly and its reasoning is still sound for what it was solving.
  Rejected because everything it needs in order to keep a *person's* series continuous across hardware - the Devices screen, the assignment endpoint, high-water seeding, `REASSIGN_RESERVE` - exists only because the number is tied to hardware rather than to the person.
  Key the number to the person and all four mechanisms are unnecessary.

- **Option C: split each person's numbers into an online bucket and an offline bucket, `1A-` and `1B-` (Rejected).**
  The intent was to keep numbers issued while disconnected, which were considered riskier, away from numbers issued while connected.
  Rejected for four reasons, each independently sufficient:
  1. **Online is a property of a moment, not of a device**, so it cannot be assigned to hardware in advance.
  2. **It reintroduces exactly the online/offline code fork [ADR 0004](0004-local-first-pos.md) exists to eliminate.** It forces the app to answer "am I online?" at the instant of Save, when the honest answer is "there is a request out that may hang for twelve seconds and then fail" - and whatever it guessed is already printed on paper.
  3. **Once every device has its own letter there are no risky numbers.** The separation would be protecting against a collision hazard the letter has already removed.
  4. **It stamps a permanent mark on paper to record a temporary condition.** Unsynced is a state that ends; the waiting-receipts marker already reports it live and stops reporting it when it stops being true, and the sale timestamp answers "when was this really sold" better than a prefix can.

- **Option D: a replacement device inherits the dead device's letter (Rejected).**
  Superficially tidier: Alvin's tablet is always `1A`.
  Rejected because inheritance requires knowing which device is being replaced, which means a device list, an assignment UI and an admin action, and because the inherited letter can collide with receipts the dead tablet issued and never synced - which is precisely the hazard `REASSIGN_RESERVE` was invented to paper over.
  A fresh letter removes the hazard instead of mitigating it.

- **Option E: keep profiles alongside per-person accounts (Rejected).**
  Two ways to say who is selling, one of which is an impersonation header, is one too many.
  Since the profiles are already `users` rows, keeping them buys nothing that a real account does not already give.

- **Option F: keep the receipt number as the idempotency key (Rejected; this is the ADR 0006 revision).**
  Retained here for the record because it was ADR 0006's chosen option and its reasoning was good at the time.
  Rejected now because coupling the two makes a duplicated receipt number silently destructive: the second sale is answered with the first sale's stored order and vanishes.
  Decoupling them leaves a duplicate merely ambiguous, which is recoverable by a human.

- **Option G: validate the device clock at sign-in or at Save (Raised and rejected by the captain).**
  The proposal was to guard against a tablet returning from a flat battery with a wrong clock and stamping sale times far in the past or future.
  Rejected as not a real failure mode on modern hardware.
  Sale time stays the device's own clock at the instant of Save, unchanged (see the glossary's "Sale time" entry), which is what keeps a printed receipt and a daily sales filter matching the paper in the drawer regardless of when the outbox drains, and the server never overwrites what the tablet stamped.
  Recorded so it is not re-raised; no clock-validation work is recommended.

---

## Implementation Notes for Later

This ADR records a settled design. It is not an implementation task, and none of the following has been built.

- `orders.receipt_station` and `orders.receipt_sequence` are integers, with the display form as a `GENERATED ALWAYS AS ... STORED` column ([ADR 0006](0006-receipt-number-as-idempotency-key.md) #2).
  The letter needs its own column and that generated expression has to be rebuilt.
  At a few thousand rows this is fiddly, **not** risky: seconds of work, not a maintenance window.
  An earlier framing of this as "the riskiest part of the build" was an overstatement and should not be carried into the record.
- **One detail a reviewer must actually verify rather than assume:** once a blank letter is possible, the partial unique index over `(receipt_station, receipt_sequence)` needs `NULLS NOT DISTINCT`, or the letter coalesced inside the index expression.
  Without that it silently stops protecting the roughly 1,300 pre-letter rows.
- `parseReceiptNumber` and `resolveOrderId` must accept all three shapes, and `assertIssuableStation` must be widened past 1-3 before a fourth person exists (decision 13).

---

## Accepted Open Issues

These are known gaps the captain has chosen to live with. They are recorded as accepted, not as solved and not as mitigated.

- **No password reset and no user-management screen.**
  Adding a person means editing the database by hand.
  A forgotten password, on a device that does not already remember that account, means that person cannot sell until they are online.
  The captain accepted this knowingly: three people, a private app shared with his parents.
  This is a known gap being ignored, **not** a mitigated risk - the captain was explicit that calling it a mitigation would be wrong.
- **No authorization of any kind.**
  Every account can do everything: edit prices, adjust stock, void deliveries, see supplier costs.
  That is fine while the accounts belong to the captain and his parents.
  The trigger, plainly: **the first person outside the family to hold an account is when permissions, and a password on the offline account switch, become necessary.**
  The instruction was not to design for this now.
- **Sale-time clocks are unguarded**, by decision. See Option G above.

---

## Consequences

- Receipt numbers issued from here on read `1A-…`, `2B-…` and so on. Today's `3-00061` numbers and the legacy `#1240` numbers are untouched and all three shapes coexist permanently.
- Every list, export and report must order by time, never by receipt number, because the three shapes do not sort as text.
- Order lookup accepts a bare sequence and may answer with several orders, so search results become a short disambiguation list rather than a jump straight to one order.
- Device replacement becomes "sign in on the new device", with no admin screen and no captain action. The person's letter changes and their sequence restarts at `00001`; their person number does not change.
- The Devices screen, the slot-assignment endpoint and `REASSIGN_RESERVE` are removed along with the slot concept, and so are `ProfileContext.jsx`, `ProfilePickerModal.jsx`, `GET /auth/profiles`, the `X-Active-Profile` header and `users.profile_key`.
- A duplicated receipt number stops being silently destructive and becomes merely ambiguous, once the retry key is a separate value (decision 9).
- The seller's name appears on the printed receipt, which makes the person prefix an optional convenience rather than the only record of who sold it.
