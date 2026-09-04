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
//
// ADR 0017 supersedes ADR 0016: the leading component of a receipt number is now the
// PERSON, not a device slot, and device replacement is a sign-in rather than a slot
// reassignment. The slot registry below still backs the Devices screen until that
// work lands; what ADR 0017 already required, and what this file carries now, is the
// widened `assertIssuableStation` — see its comment.

const SLOT_OWNERS = Object.freeze({ 1: 'Alvin', 2: 'Josie', 3: 'Luis' });

const SLOT_NUMBERS = Object.freeze([1, 2, 3]);

const MAX_SLOT = 3;

function isSlotNumber(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SLOT;
}

function ownerName(slotNumber) {
  return SLOT_OWNERS[slotNumber] || null;
}

// The backstop behind the allocator, widened by ADR 0017.
//
// Under ADR 0016 this refused any station outside the three slots. ADR 0017 keys the
// leading number to a PERSON rather than to a device slot, and a new hire takes the
// next number, so a hard cap of 3 would reject the first sale a fourth person ever
// makes at POST /orders. Widening it is a prerequisite of that change and is
// unrelated to the both-formats switchover window (ADR 0014, ADR 0017 #13).
//
// What it still refuses is a value that cannot be a person at all — zero, negative,
// fractional, or absurdly large — so a garbled or missing number is still rejected
// loudly rather than stored as a receipt nobody can trace. MAX_ISSUABLE_STATION is a
// sanity ceiling, not a roster: it is deliberately far above any plausible headcount
// for a family business, because the number of the last person hired is not something
// this function should have to be kept in step with.
//
// Deliberately NOT applied to reads: the numbers already in the table stay exactly as
// they are (ADR 0016 #4, ADR 0017 #12), and parseReceiptNumber stays format-only so a
// historical value still parses for display and lookup.
const MAX_ISSUABLE_STATION = 999;

function isIssuableStation(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ISSUABLE_STATION;
}

function assertIssuableStation(station, { field = 'receipt_number' } = {}) {
  if (isIssuableStation(station)) return;
  const err = new Error(
    `${field} person number ${station} is not a valid one — it must be a whole number ` +
    `between 1 and ${MAX_ISSUABLE_STATION}.`
  );
  err.status = 400;
  throw err;
}

module.exports = {
  SLOT_OWNERS, SLOT_NUMBERS, MAX_SLOT, isSlotNumber, ownerName,
  MAX_ISSUABLE_STATION, isIssuableStation, assertIssuableStation,
};
