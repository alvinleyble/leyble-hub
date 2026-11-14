// The bottle deposit at close — one rule for the screens and both receipts.
//
// The listed price already includes every bottle's deposit, so a line is worth
// quantity × unit_price − bottles_returned × unit_deposit_fee: the order_items.line_total
// GENERATED column since migration 051. Red Horse Grande 1L lists at ₱641.00 a case
// (6 bottles at ₱4.50); with all six back the customer pays ₱614.00, with none back
// ₱641.00. Nothing is ever added on top of the listed price.

// Returns are only counted at the closing step: delivered (completed) and closed (done).
export const countsReturns = (status) => status === 'completed' || status === 'done';

// Bottles returned on a line. A count being typed on the close form (`returnCounts`,
// keyed by item id) wins over the saved one while it holds a value.
export function bottlesReturned(item, returnCounts = {}) {
  const entry = returnCounts[item.id];
  const typing = item.requires_bottle_return && entry !== undefined && entry !== '';
  return Math.max(Number(typing ? entry : item.bottles_returned) || 0, 0);
}

// The amount taken off a line for its returned bottles (0 when none came back).
export function bottleCredit(item, returnCounts = {}) {
  const fee = Number(item.unit_deposit_fee) || 0;
  return fee > 0 ? bottlesReturned(item, returnCounts) * fee : 0;
}
