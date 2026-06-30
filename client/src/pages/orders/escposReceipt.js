// ESC/POS receipt generator for 80mm thermal printers (48 chars/line at normal size).
// Produces a Uint8Array sent directly to the printer via Bluetooth — no dialog needed.

const W   = 48;
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

function fmtMoney(n) {
  const num = Number(n);
  const abs = Math.abs(num);
  const s   = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (num < 0 ? '-PHP' : 'PHP') + s;
}

// Pad left + right strings to fill W chars (at least 1 space between).
function padLR(left, right, w = W) {
  const gap = w - left.length - right.length;
  return left + ' '.repeat(Math.max(1, gap)) + right;
}

// Word-wrap text to at most w chars per line, returns array of strings.
function wrap(text, w = W) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function itemDepositForPrint(item, returnCounts, showDeposit) {
  if (!showDeposit) return 0;
  const dep = Number(item.unit_deposit_fee);
  if (!dep) return 0;
  const totalBtl = Number(item.quantity) * (Number(item.units_per_case) || 1);
  const isLive   = item.requires_bottle_return
    && returnCounts[item.id] !== undefined && returnCounts[item.id] !== '';
  const returned = isLive
    ? Math.max(Number(returnCounts[item.id]) || 0, 0)
    : Math.max(Number(item.bottles_returned) || 0, 0);
  return (totalBtl - returned) * dep;
}

export function generateEscPos(order, returnCounts = {}, overrides = {}) {
  const isPickup    = order.order_type === 'pickup';
  const showDeposit = order.status === 'completed' || order.status === 'done';

  const docDate  = new Date(order.created_at);
  const dateStr  = `${String(docDate.getMonth() + 1).padStart(2, '0')}/${String(docDate.getDate()).padStart(2, '0')}/${docDate.getFullYear()}`;
  const receiptNo = String(order.id).padStart(5, '0');

  const printAdj       = Number(overrides.adjustment !== undefined ? overrides.adjustment : (order.adjustment || 0)) || 0;
  const printAdjReason = overrides.adjustment_reason !== undefined ? overrides.adjustment_reason : order.adjustment_reason;
  const itemsTotal     = order.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
  const depTotal       = order.items.reduce((s, i) => s + itemDepositForPrint(i, returnCounts, showDeposit), 0);
  const printTotal     = itemsTotal + depTotal + printAdj;
  const hasSubtotals   = (showDeposit && depTotal > 0) || printAdj !== 0;

  const buf = [];
  const b   = (...bytes) => { for (const v of bytes) buf.push(v); };
  const s   = (str) => { for (let i = 0; i < str.length; i++) buf.push(str.charCodeAt(i) & 0xFF); };
  const ln  = (str = '') => { s(str); b(LF); };
  const hr  = () => ln('-'.repeat(W));

  // Init
  b(ESC, 0x40);

  // ── Header ─────────────────────────────────────────────────────────────────
  b(ESC, 0x61, 0x01);   // center
  b(ESC, 0x45, 0x01);   // bold on
  b(GS,  0x21, 0x10);   // double-width
  ln('LEYBLE GENERAL');
  ln('MERCHANDISE');
  b(GS,  0x21, 0x00);   // normal size
  b(ESC, 0x45, 0x00);   // bold off
  ln('0917-860-5512 / 0955-330-3407 / 0919-004-4652');
  ln();
  b(ESC, 0x61, 0x00);   // left
  hr();

  // ── Receipt type + meta ────────────────────────────────────────────────────
  b(ESC, 0x45, 0x01);
  ln(isPickup ? 'PICKUP RECEIPT' : 'DELIVERY RECEIPT');
  b(ESC, 0x45, 0x00);
  ln(padLR(`No: ${receiptNo}`, dateStr));

  // ── Customer / personnel ───────────────────────────────────────────────────
  hr();
  ln(`${isPickup ? 'Received by' : 'Delivered to'}: ${order.customer_name}`);
  if (order.customer_address) {
    for (const l of wrap(`Address: ${order.customer_address}`)) ln(l);
  }
  if (order.personnel?.length > 0) {
    const pLine = order.personnel.map((p) => `${p.full_name} (${p.role})`).join(', ');
    for (const l of wrap(`Personnel: ${pLine}`)) ln(l);
  }
  if (order.notes) {
    for (const l of wrap(`Note: ${order.notes}`)) ln(l);
  }

  // ── Items ──────────────────────────────────────────────────────────────────
  hr();
  for (const item of order.items) {
    const qty      = Number(item.quantity);
    const dep      = Number(item.unit_deposit_fee);
    const upc      = Number(item.units_per_case) || 1;
    const itemDep  = itemDepositForPrint(item, returnCounts, showDeposit);
    const lineTotal = qty * Number(item.unit_price) + itemDep;

    // Product name / SKU (bold)
    b(ESC, 0x45, 0x01);
    ln(item.sku || item.product_name || '');
    b(ESC, 0x45, 0x00);

    // qty × price → total
    const qtyLabel = `  ${qty} ${item.unit || 'cs'} x ${fmtMoney(item.unit_price)}`;
    ln(padLR(qtyLabel, fmtMoney(lineTotal)));

    // Deposit breakdown
    if (showDeposit && dep > 0 && itemDep !== 0) {
      const totalBtl = qty * upc;
      const isLive   = item.requires_bottle_return
        && returnCounts[item.id] !== undefined && returnCounts[item.id] !== '';
      const returned = isLive
        ? Math.max(Number(returnCounts[item.id]) || 0, 0)
        : Math.max(Number(item.bottles_returned) || 0, 0);

      ln(padLR(`  Dep: ${totalBtl}btl x ${fmtMoney(dep)}`, fmtMoney(totalBtl * dep)));
      if (returned > 0) {
        ln(padLR(`  Ret: ${returned}btl x ${fmtMoney(dep)}`, `-${fmtMoney(returned * dep)}`));
        const netBtl = totalBtl - returned;
        ln(padLR(netBtl < 0 ? '  Net credit' : '  Net deposit', fmtMoney(itemDep)));
      }
    }
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  hr();
  if (hasSubtotals) {
    ln(padLR('Items', fmtMoney(itemsTotal)));
    if (showDeposit && depTotal > 0) ln(padLR('Deposit fee', `+${fmtMoney(depTotal)}`));
    if (printAdj !== 0) {
      const adjRaw = printAdjReason ? `Adj (${printAdjReason})` : 'Adjustment';
      const adjLabel = adjRaw.length > 28 ? adjRaw.substring(0, 25) + '...' : adjRaw;
      ln(padLR(adjLabel, (printAdj > 0 ? '+' : '') + fmtMoney(printAdj)));
    }
  }
  b(ESC, 0x45, 0x01);
  ln(padLR(hasSubtotals ? 'FINAL TOTAL' : 'TOTAL', fmtMoney(printTotal)));
  b(ESC, 0x45, 0x00);

  // ── Terms ──────────────────────────────────────────────────────────────────
  hr();
  const terms = "TERMS: 18% interest per annum will be charged to vendee on all overdue accounts plus 25% of the amount due as attorney's fee in case of legal action that may arise out of the transaction and the venue shall be in Antipolo City";
  for (const l of wrap(terms)) ln(l);

  // ── Signature ──────────────────────────────────────────────────────────────
  ln();
  b(ESC, 0x61, 0x01);
  ln('Received the above merchandise');
  ln('in good order and condition');
  ln();
  b(ESC, 0x61, 0x00);
  ln('By: ' + '_'.repeat(W - 4));

  // ── Feed + partial cut ─────────────────────────────────────────────────────
  b(ESC, 0x64, 0x04);   // feed 4 lines
  b(GS,  0x56, 0x41, 0x03);  // partial cut

  return new Uint8Array(buf);
}
