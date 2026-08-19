// Shared ticket math for the V2 POS. Kept in one place so the on-screen ticket,
// the History rows and the printed receipt can never drift apart.
//
// Deposit rule (V2, see docs/product/proposals/v2-tablet-pos-overhaul.md §2.4):
// the per-bottle deposit is charged in full at sale and folded into what the
// screen and the receipt show. It is display-only — the stored `total_amount`
// stays goods-only, exactly as `recomputeTotal` writes it server-side.

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Cases are entered in 0.5 steps; keep them off floating-point dust.
export const roundQty = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Goods value of a line: cases × price per case.
export const lineGoods = (item) =>
  round2((Number(item.quantity) || 0) * (Number(item.unit_price) || 0));

// Deposit value of a line: every bottle in the line, at the line's per-bottle fee.
// Lines whose product needs no bottle return carry a 0 fee, so this is 0 for them.
export const lineDeposit = (item) =>
  round2(
    (Number(item.quantity) || 0) *
    (Number(item.units_per_case) || 1) *
    (Number(item.unit_deposit_fee) || 0)
  );

export const lineTotal = (item) => round2(lineGoods(item) + lineDeposit(item));

// Whole-ticket totals. `adjustment` is the ± discount / suki correction.
export function ticketTotals(items, adjustment = 0) {
  const goods   = round2(items.reduce((s, i) => s + lineGoods(i), 0));
  const deposit = round2(items.reduce((s, i) => s + lineDeposit(i), 0));
  const adj     = round2(adjustment);
  return { goods, deposit, adjustment: adj, total: round2(goods + deposit + adj) };
}

// Total cases on the ticket (0.5-case aware) — printed on the receipt too.
export const totalCases = (items) =>
  roundQty(items.reduce((s, i) => s + (Number(i.quantity) || 0), 0));
