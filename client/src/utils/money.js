// How money is written on screen (docs/design/design-standard.md, Q15): always
// "₱1,234.50", a negative as "−₱135.00" (the minus before the peso sign, a real minus
// character so it can't be read as a hyphen), and a plus sign only where a list mixes
// credits and debits. Callers put the result in a `whitespace-nowrap` element so an
// amount is never split across lines. Printed receipts keep their own formatting in
// receiptTemplate.js / escposReceipt.js — paper is not governed by this.

const MINUS = '−';

function amount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function digits(v) {
  return Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPeso(n) {
  const v = amount(n);
  // -0.001 rounds to "0.00" and must not print as "−₱0.00".
  const negative = v < 0 && digits(v) !== '0.00';
  return `${negative ? MINUS : ''}₱${digits(v)}`;
}

// For lists that mix credits and debits (tickets, adjustments): "+₱120.00" / "−₱135.00".
export function formatSignedPeso(n) {
  const v = amount(n);
  if (v > 0 && digits(v) !== '0.00') return `+₱${digits(v)}`;
  return formatPeso(v);
}

export const PHP = formatPeso;
