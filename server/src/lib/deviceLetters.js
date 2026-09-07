// ADR 0017 #2/#3 — the per-person device letter.
//
// A receipt number is `<person><device letter>-<sequence>`, e.g. `1A-00042`. The letter
// distinguishes ONE PERSON'S own devices from each other and nothing else: Alvin's
// tablet is `1A`, his phone `1B`, his browser `1C`, and the same physical tablet is
// legitimately `2B` for Josie. It is never globally meaningful.
//
// Allocation is strictly forward, never gap-filling. `nextDeviceLetter` is handed the
// HIGHEST letter that person has ever been allocated and returns the one after it, so a
// replacement device gets a letter that has never been used by that person — which is
// precisely what lets ADR 0017 #3 drop ADR 0016's device list, assignment UI, high-water
// seeding and `REASSIGN_RESERVE`. A fresh letter cannot collide with receipts a dead
// tablet issued and never synced; a recycled one can.
//
// The enumeration is bijective base-26: A..Z, then AA..ZZ. Two characters is what
// `user_devices.device_letter VARCHAR(2)` and its CHECK allow (migration 042), giving
// 702 devices per person — several lifetimes of replacements for a three-person store.

const MAX_LETTER_LENGTH = 2;

const LETTER_RE = /^[A-Z]{1,2}$/;

function isDeviceLetter(value) {
  return typeof value === 'string' && LETTER_RE.test(value);
}

// The order allocation walks, and therefore the order a query must sort by to find a
// person's highest letter: shorter before longer first ('Z' precedes 'AA'), then
// alphabetical. Plain text ordering would put 'AA' before 'B' and hand out a letter
// that person already holds.
function compareDeviceLetters(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * The next letter after `current`, or 'A' when this person has no device yet.
 *
 * Throws a 400-tagged error rather than returning a three-character letter the column
 * cannot hold: an unstorable letter must fail the sign-in loudly, not be truncated into
 * one the person already holds.
 */
function nextDeviceLetter(current) {
  if (current === null || current === undefined || current === '') return 'A';
  const from = String(current).toUpperCase();
  if (!isDeviceLetter(from)) {
    throw new Error(`'${current}' is not a device letter`);
  }

  const chars = from.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A'; // carried: 'AZ' -> 'BA', and 'ZZ' falls out of the loop below
  }

  const widened = 'A'.repeat(from.length + 1);
  if (widened.length > MAX_LETTER_LENGTH) {
    const err = new Error(
      `This account has used all ${26 + 26 * 26} device letters — no further device can be registered to it.`
    );
    err.status = 400;
    throw err;
  }
  return widened;
}

module.exports = {
  MAX_LETTER_LENGTH, isDeviceLetter, compareDeviceLetters, nextDeviceLetter,
};
