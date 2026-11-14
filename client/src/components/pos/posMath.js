// Shared order math for the V2 POS. Kept in one place so the on-screen order,
// the History rows and the printed receipt can never drift apart.
//
// Totals are quantity × listed price per case (captain's correction, 2026-08-20;
// see proposal §2.4). The listed price already includes every bottle's deposit
// (migration 051); returned bottles are credited only when V1 closes the order and
// counts them, and §2.1 makes `pending` V2's terminal state, so V2 never reaches that
// step. Lines still carry `unit_deposit_fee` to the backend for V1's close — the POS
// just never shows it.

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Cases are entered in 0.5 steps; keep them off floating-point dust.
export const roundQty = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Value of a line: cases × price per case.
export const lineTotal = (item) =>
  round2((Number(item.quantity) || 0) * (Number(item.unit_price) || 0));

// Whole-order totals. `adjustment` is the ± discount / suki correction.
export function orderTotals(items, adjustment = 0) {
  const goods = round2(items.reduce((s, i) => s + lineTotal(i), 0));
  const adj   = round2(adjustment);
  return { goods, adjustment: adj, total: round2(goods + adj) };
}

// Total cases on the order (0.5-case aware) — printed on the receipt too.
export const totalCases = (items) =>
  roundQty(items.reduce((s, i) => s + (Number(i.quantity) || 0), 0));
