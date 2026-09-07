// ADR 0017 — validating the PERSON half of a receipt number.
//
// A receipt number is `<person><device letter>-<sequence>`. The leading number is the
// account that sold it: permanent, never reused, and allocated on that person's first
// device claim (see `ensurePersonNumber` in server/src/routes/stations.js).
//
// This file used to be `stationSlots.js` and carried ADR 0016's three fixed slots —
// 1 Alvin, 2 Josie, 3 Luis — a registry of which device held which slot, plus the
// vocabulary the Devices screen rendered. ADR 0017 supersedes ADR 0016: the number is
// keyed to the person, not to hardware, and a replacement device takes a fresh letter
// on sign-in rather than being assigned a slot. All of that vocabulary is gone with the
// slot concept; what survives is the one thing that was never about slots — the
// backstop that refuses a leading number no person could have.

// The backstop behind the allocator, widened by ADR 0017.
//
// Under ADR 0016 this refused any station outside the three slots. ADR 0017 keys the
// leading number to a PERSON rather than to a device slot, and a new hire takes the
// next number, so a hard cap of 3 would reject the first sale a fourth person ever
// makes at POST /orders.
//
// What it still refuses is a value that cannot be a person at all — zero, negative,
// fractional, or absurdly large — so a garbled or missing number is still rejected
// loudly rather than stored as a receipt nobody can trace. MAX_ISSUABLE_STATION is a
// sanity ceiling, not a roster: it is deliberately far above any plausible headcount
// for a family business, because the number of the last person hired is not something
// this function should have to be kept in step with.
//
// Deliberately NOT applied to reads: the numbers already in the table stay exactly as
// they are (ADR 0017 #12), and parseReceiptNumber stays format-only so a historical
// value still parses for display and lookup.
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

module.exports = { MAX_ISSUABLE_STATION, isIssuableStation, assertIssuableStation };
