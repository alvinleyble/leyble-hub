// ADR 0016 — the three fixed station slots.
//
// A receipt number is `<station>-<sequence>`. Before this, `<station>` was whatever
// number the device drew from station_number_seq when it registered, so it was
// unbounded and a replaced tablet started a fresh number space. This store runs
// exactly three tablets, strictly one per person, so `<station>` is now a SLOT the
// device is assigned to — 1, 2 or 3 — and nothing else is issuable.
//
// The owner names are fixed here rather than in a table because the mapping is the
// decision, not data the owners edit: slot 1 is Alvin's tablet, 2 is Josie's, 3 is
// Luis's, permanently. Which physical device currently holds each slot IS data, and
// lives in `stations.slot_number` (migration 037).

const SLOT_OWNERS = Object.freeze({ 1: 'Alvin', 2: 'Josie', 3: 'Luis' });

const SLOT_NUMBERS = Object.freeze([1, 2, 3]);

const MAX_SLOT = 3;

function isSlotNumber(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SLOT;
}

function ownerName(slotNumber) {
  return SLOT_OWNERS[slotNumber] || null;
}

// The backstop behind the allocator. The device can only ever hold a slot the server
// gave it, but a tablet still running a pre-ADR-0016 build carries a station number
// it claimed under the old scheme, and would otherwise print (and sync) `8-00001`.
// Rejecting it here is what makes ADR 0016 #1 — "no order created from here on shows
// a station above 3" — true of the stored row, not merely of the current client.
//
// Deliberately NOT applied to reads: the numbers already in the table stay exactly as
// they are (ADR 0016 #4), and parseReceiptNumber stays format-only so a historical
// value still parses for display and lookup.
function assertIssuableStation(station, { field = 'receipt_number' } = {}) {
  if (isSlotNumber(station)) return;
  const err = new Error(
    `${field} station ${station} is not one of this store's three tablets (1, 2 or 3). ` +
    'Assign this device a slot in Back Office → Devices before it can issue receipts.'
  );
  err.status = 400;
  throw err;
}

module.exports = { SLOT_OWNERS, SLOT_NUMBERS, MAX_SLOT, isSlotNumber, ownerName, assertIssuableStation };
