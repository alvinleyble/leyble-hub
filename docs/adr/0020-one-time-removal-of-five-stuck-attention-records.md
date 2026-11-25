# One-Time Removal of Five Stuck Needs-Attention Records

**Status:** Settled (2026-11-25)  
**Origin:** Owner's explicit instruction, 2026-11-25  
**Code:** [`client/src/offline/stuckRecordCleanup.js`](../../client/src/offline/stuckRecordCleanup.js) (called from `startOfflineCore` in [`client/src/offline/index.js`](../../client/src/offline/index.js))  
**See also:** [V2.5 proposal D8](../product/proposals/v2-5-offline-accessibility.md), [ADR 0017: Receipt Numbers Keyed to User Accounts](0017-receipt-numbers-keyed-to-user-accounts.md)

## Context

V2.5 D8 says a record the server refuses goes to the Needs attention list and is
**never discarded and never auto-resolved**: someone re-points it or sends it again
from that list.

Five records stuck on that list on three production devices, and the owner could not
clear them from the phones. The numbers, as read off each device's list:

| Device | Numbers |
|---|---|
| 1C (Alvin) | 478, 981 |
| 3D (Luis) | 1677, 2345 |
| 2A (Josefina) | 2738 |

The owner asked for the app to lose them, without anyone going to the phones and without
telling the people using them to do anything. It does not matter whether they are sales
or other queued changes. Asked what should happen to a record waiting behind one of them
that cannot be sent without it: "remove it too".

## Decision

The next app update carries a one-time step that removes exactly this fixed set and
nothing else, then never runs again on that install.

1. **Matching.** The set is checked only on the device that holds the named code. A
   device knows its codes from the person-and-device letters it holds (`heldDeviceCodes`
   in `station.js`). A record matches only if it is on the Needs attention list when the
   step runs, and only in the shape the list showed it: `#478` (no receipt number, queue
   id 478), or `1C-00478` (its receipt number parses, via `parseReceiptNumber`, to that
   device code and sequence). Queued or sending records are never matched. Neither is a
   pre-letter number (`1-00478`) or a delivery reference (`1C-DEL-00478`).
2. **Waiters go too.** Every record waiting behind a matched one, directly or through a
   chain, is removed with it. "Waiting behind" uses the same two rules the drain uses:
   `depends_on`, and a write addressed to an order whose create is being removed
   (`waitsOn`). Nothing else is removed.
3. **Local state.** A removed sale's held receipt goes with it, but only one the server
   never had (no server row id). Without its record nothing marks it unsynced, so it
   would read as a synced order. Removed ids are dropped from the server-error park
   streak so they no longer count toward its cap. Everything else is left as it is.
4. **Once.** A marker (`v25.oneTime.stuckRecordsRemoved20261125`) is written once the
   step has run on a device that knows its code, whatever it found. With the marker
   present the step does nothing. Before the device knows its code, nothing runs and no
   marker is written.
5. **Safe to fail.** If the step fails, it puts back every key it had touched and writes
   no marker. It is not awaited at start, so it never delays the app.
6. **Nothing visible.** No copy of the removed records is kept. No screen, button,
   setting, message or confirmation is added.

D8 stays in force for every other record, on every device.

## Alternatives considered

- **A "remove" button in the Needs attention list.** Rejected: someone would have to
  open the list and tap it on each of the three phones, which is exactly what the owner
  asked to avoid. It would also put a general way to discard refused records in front of
  every operator, against D8.
- **The phone reports its stuck records and they are removed from the server side.**
  Rejected: a much larger build. It needs a new reporting endpoint, a server-side
  instruction channel back to a named device, and a way to choose records on the server.
  All of that would be for five records.

## Consequences

- **Receipt-sequence gaps.** A sale that never reached the server leaves a permanent gap
  in its device's receipt sequence (for example, no `1C-00478` on the server). Nothing
  notices or tries to fill it. The device never re-issues a number: its counter only
  moves forward, and `seedSequence` never moves it down. `POST /stations/register`
  re-seeds from the server's highest sequence for the pair, which is a floor, not a
  contiguity check. The server's partial unique index only refuses duplicates. Later
  sales from these devices sync as usual.
- **Cached figures from removed edits.** A removed product, customer or personnel edit,
  or a removed delivery, may already have written its value onto the device's cached
  catalogue. That value stays until the next sync delta for that row replaces it. The
  record itself is no longer counted or badged as waiting anywhere.
- **A removed draft discard.** If a removed record was a queued draft discard, that
  draft shows in Drafts again if the server still holds it, because the delete never
  happened.
- **Removing the step later.** Delete `stuckRecordCleanup.js`, its call in
  `offline/index.js`, its test, and the `heldDeviceCodes` / `PARK_STREAK_KEY` exports if
  nothing else uses them, once every device has updated past it. A leftover marker key
  is harmless.
