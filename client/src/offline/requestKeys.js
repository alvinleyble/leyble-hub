// ADR 0017 #9 — the retry key, split off the receipt number.
//
// One key per OUTBOX RECORD, minted when the record is enqueued and resent unchanged
// on every retry of that record. It labels the *attempt to send a sale*; the receipt
// number labels the *sale*. Two identifiers, two jobs, and — the objection ADR 0006
// rejected this on and ADR 0017 overturns — no way for them to disagree.
//
// Why this matters on the device specifically: the outbox retries on the operator's
// behalf, so a POST that commits on the server and then loses its response is sent
// again. Keyed on the receipt number, a second sale that happened to reuse a number
// was answered with the FIRST sale's stored order and vanished. Keyed on this, a
// resent record is recognised as a resend, and two different sales stay two sales.
//
// Kept free of Capacitor and of the storage layer so it can be imported and tested
// anywhere. The value is opaque: nobody reads it, nothing displays it, and it is
// never printed on paper.

// Fits VARCHAR(64) in migration 039 and the server's `request_key` charset check
// (server/src/lib/idempotency.js): `rk_` plus 32 hex characters = 35.
const PREFIX = 'rk_';
const BYTES = 16;

function randomBytes(n) {
  const out = new Uint8Array(n);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(out);
    return out;
  }
  // Last resort only (an old WebView, a test runner without webcrypto). Weaker, but a
  // collision here would have to land inside one device's own outbox to matter at all,
  // and refusing to mint a key would mean refusing to save the sale.
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A fresh retry key, e.g. 'rk_9f2c…'. Never derived from the receipt number. */
export function newRequestKey() {
  let hex = '';
  for (const byte of randomBytes(BYTES)) hex += byte.toString(16).padStart(2, '0');
  return `${PREFIX}${hex}`;
}

export function isRequestKey(value) {
  return typeof value === 'string' && new RegExp(`^${PREFIX}[0-9a-f]{${BYTES * 2}}$`).test(value);
}
