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

The next app update carries a step that removes exactly this fixed set and nothing else.
It is still a one-time removal of a fixed set; what repeats is the check for it.

1. **Matching.** The set is checked only on the device that holds the named code. A
   device knows its codes from the person-and-device letters it holds (`heldDeviceCodes`
   in `station.js`). A record matches only if it is on the Needs attention list at the
   moment a pass looks, was created before the cutoff (decision 4), and the number names
   it in one of three shapes:
   - **Queue id.** The attention card shows `#478`: the record has no receipt number and
     its queue id is 478.
   - **Own receipt number.** The card shows `1C-00478`: the record's receipt number
     parses, via `parseReceiptNumber`, to that device code and sequence.
   - **Target order.** Sync details, which opens from the attention list's footer, names
     a change addressed to an order by that order and not by its queue id: "Receipt
     printed: order #478" for a record whose card reads `#57`. A status change, a
     receipt-printed mark, a draft discard, or any other record whose endpoint is
     addressed to an order, matches when that order is `#478` (the order's row id) or
     `1C-00478`. The target is resolved by the helper Sync details itself uses
     (`targetOrderRef` in `syncDetails.js`), never by searching text.

   Queued or sending records are never matched, in any shape. Neither is a number under
   another device's code, a pre-letter number (`1-00478`) or a delivery reference
   (`1C-DEL-00478`).

   The third shape was the owner's pick (2026-11-25, "A."), because it cannot be told
   from outside the phones which screen each number was read from. Its cost: any stuck
   change addressed to that order number on that device is removed, even if it is not
   the one that was seen.
2. **Waiters go too.** Every record waiting behind a matched one, directly or through a
   chain, is removed with it, whatever its own creation time. "Waiting behind" uses the
   same two rules the drain uses: `depends_on`, and a write addressed to an order whose
   create is being removed (`waitsOn`). Nothing else is removed.
3. **Local state.** A removed sale's held receipt goes with it, but only one the server
   never had (no server row id). Without its record nothing marks it unsynced, so it
   would read as a synced order. Removed ids are dropped from the server-error park
   streak so they no longer count toward its cap. Everything else is left as it is.
4. **Every start, bounded by a creation cutoff.** There is no run-once marker. A pass
   runs at every app start for as long as the step ships, and again whenever a drain
   moves a record to Needs attention (the outbox's existing `drain` announcement with
   `failed > 0`). That is what catches a named record that was being retried when the
   update first started ("Send again as is" puts it back in the queue): it is still
   never matched while queued, and the pass that follows its return to the list removes
   it. Passes run one at a time, and a pass with nothing to do writes nothing.

   What keeps this from ever touching a later record is the cutoff: a matched record
   must have been created before `2026-11-26T00:00:00+08:00`, the end of 2026-11-25 in
   Manila, by the `created_at` its device stamped when it was queued. A record with no
   readable creation time is not matched. `enqueue` has stamped `created_at` on every
   record since the outbox was first built (V3.0), so no shipped build made one without
   it.
5. **Safe to fail, safe to interrupt.** A held receipt is removed before its record, and
   records are removed waiters first, matched records last. However a pass is cut short,
   whatever is left of a matched record's chain still has that record on the attention
   list in front of it: the drain keeps holding it back, and the next pass matches the
   record again and finishes. A pass that fails puts back what it changed, newest change
   first, and stops at the first key it cannot put back, which leaves that same kind of
   state. It is not awaited at start, so it never delays the app.
6. **Nothing visible.** No copy of the removed records is kept. No screen, button,
   setting, message or confirmation is added.

D8 stays in force for every other record, on every device.

## Alternatives considered

- **Run once, behind a marker.** The first build of this step ran a single time per
  install and then wrote a marker. Rejected at review: a named record that was back in
  the queue at that one instant was missed for good, and so was a pass interrupted
  partway, with another release as the only remedy. The creation cutoff gives the same
  guarantee the marker did (nothing made later can match) without the single chance.
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
  nothing else uses them, once the five are gone from all three devices. It leaves
  nothing behind on a device.
