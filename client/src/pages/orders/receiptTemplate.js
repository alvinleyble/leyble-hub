const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Which print-tag phase a Print Receipt click should prompt for, based on the
// order's status at the time of printing. in_transit/cancelled get no prompt.
export function printPhaseForStatus(status) {
  if (status === 'pending') return 'pending';
  if (status === 'completed' || status === 'done') return 'delivered';
  return null;
}

// Builds the full 80mm thermal receipt HTML for an order. `overrides` lets the caller
// pass live (unsaved) values so the printed receipt matches the on-screen review summary
// — currently `adjustment` / `adjustment_reason` from the in-progress close/dispatch form.
export function generateReceiptHtml(order, returnCounts = {}, overrides = {}) {
  const docDate = new Date(order.created_at);
  const dateStr = `${String(docDate.getMonth() + 1).padStart(2, '0')}/${String(docDate.getDate()).padStart(2, '0')}/${docDate.getFullYear()}`;
  const docHours = docDate.getHours();
  const timeStr = `${docHours % 12 || 12}:${String(docDate.getMinutes()).padStart(2, '0')} ${docHours < 12 ? 'AM' : 'PM'}`;
  // D1 — the number the customer's copy is filed under. A device-issued receipt
  // number ('1-00042') when the order has one; otherwise the row id, zero-padded, as
  // every receipt printed before V2.5 was.
  const receiptNo = order.receipt_number || String(order.id).padStart(5, '0');
  // ADR 0017 #10 — the seller, printed in words next to the number. This is the exit
  // ramp the decision names: once the name is on the paper, the person digit leading
  // the receipt number is an optional convenience rather than the only record of who
  // sold it. Orders from before migration 042 carry no seller and are never backfilled
  // (ADR 0017 #12), so the line is simply omitted rather than printed empty.
  const soldBy = (order.sold_by_name || '').trim();
  const isPickupOrder = order.order_type === 'pickup';
  // Deposit only appears on the closing receipt (status = completed/delivered).
  // Pending receipts assume full bottle return — no deposit charged.
  const showDeposit = order.status === 'completed' || order.status === 'done';

  const itemDepForPrint = (item) => {
    if (!showDeposit) return 0;
    const dep = Number(item.unit_deposit_fee);
    if (!dep) return 0;
    const totalBtl = Number(item.quantity) * (Number(item.units_per_case) || 1);
    const isLive = item.requires_bottle_return
      && returnCounts[item.id] !== undefined
      && returnCounts[item.id] !== '';
    const returned = isLive
      ? Math.max(Number(returnCounts[item.id]) || 0, 0)
      : Math.max(Number(item.bottles_returned) || 0, 0);
    return (totalBtl - returned) * dep;
  };

  const printItemsTotal   = order.items.reduce(
    (s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
  const printDepositTotal = order.items.reduce((s, i) => s + itemDepForPrint(i), 0);
  const printAdj          = Number(
    overrides.adjustment !== undefined ? overrides.adjustment : (order.adjustment || 0)
  ) || 0;
  const printAdjReason    = overrides.adjustment_reason !== undefined
    ? overrides.adjustment_reason
    : order.adjustment_reason;
  const printTotal        = printItemsTotal + printDepositTotal + printAdj;
  const printHasSubtotals = (showDeposit && printDepositTotal > 0) || printAdj !== 0;
  const printTotalCases   = order.items.reduce((s, i) => s + Number(i.quantity), 0);

  const itemRows = order.items.map((item) => {
    const qty      = Number(item.quantity);
    const dep      = Number(item.unit_deposit_fee);
    const upc      = Number(item.units_per_case) || 1;
    const totalBtl = qty * upc;
    const itemDep  = itemDepForPrint(item);
    const displayTotal = qty * Number(item.unit_price) + itemDep;

    let depLine = '';
    // Show the deposit breakdown whenever there's a net charge (un-returned bottles)
    // or a net credit (over-returned bottles). Skip only when itemDep is exactly 0
    // (all bottles returned — nothing owed either way).
    if (showDeposit && dep > 0 && itemDep !== 0) {
      const isLive = item.requires_bottle_return
        && returnCounts[item.id] !== undefined
        && returnCounts[item.id] !== '';
      const returned = isLive
        ? Math.max(Number(returnCounts[item.id]) || 0, 0)
        : Math.max(Number(item.bottles_returned) || 0, 0);
      const netBtl = totalBtl - returned;
      depLine = `<div style="display:flex;justify-content:space-between;font-size:10px;color:#444;margin-top:1px">
           <span>&nbsp;&nbsp;Deposit: ${totalBtl} btls &times; ${PHP(dep)}</span>
           <span>${PHP(totalBtl * dep)}</span>
         </div>`;
      if (returned > 0) {
        const netLabel = netBtl < 0 ? 'Net credit' : 'Net deposit';
        const netVal   = netBtl < 0
          ? `-${PHP(Math.abs(netBtl) * dep)}`
          : PHP(netBtl * dep);
        depLine += `<div style="display:flex;justify-content:space-between;font-size:10px;color:#444">
           <span>&nbsp;&nbsp;Returned: ${returned} btls &times; ${PHP(dep)}</span>
           <span>-${PHP(returned * dep)}</span>
         </div>
         <div style="display:flex;justify-content:space-between;font-size:10px;color:#444">
           <span>&nbsp;&nbsp;${netLabel}</span>
           <span>${netVal}</span>
         </div>`;
      }
    }
    return `
      <div style="margin-bottom:5px">
        <div style="font-weight:bold">${item.sku || ''}</div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#333">&nbsp;&nbsp;${qty} ${item.unit || 'cs'} &times; ${PHP(item.unit_price)}</span>
          <span>${PHP(displayTotal)}</span>
        </div>
        ${depLine}
      </div>`;
  }).join('');

  const totalCasesRow = `
    <div class="row-between" style="margin-top:3px">
      <span>Total Cases</span><span>${printTotalCases} pcs</span>
    </div>`;

  const subtotalRows = printHasSubtotals ? `
    <div class="row-between" style="margin-top:3px">
      <span>Items</span><span>${PHP(printItemsTotal)}</span>
    </div>${showDeposit && printDepositTotal > 0 ? `
    <div class="row-between">
      <span>Deposit fee</span><span>+${PHP(printDepositTotal)}</span>
    </div>` : ''}${printAdj !== 0 ? `
    <div class="row-between">
      <span>Adjustment${printAdjReason ? ` (${printAdjReason})` : ''}</span>
      <span>${printAdj > 0 ? '+' : ''}${PHP(printAdj)}</span>
    </div>` : ''}` : '';

  const personnelLine = order.personnel?.length > 0
    ? `<div style="margin-top:2px">Driver/Helper: ${order.personnel.map((p) => `${p.full_name} (${p.role})`).join(', ')}</div>`
    : '';

  const notesLine = order.notes
    ? `<div style="margin-top:2px;font-style:italic">Note: ${order.notes}</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt ${receiptNo}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px;
    width: 72mm;
    margin: 0 auto;
    padding: 4mm 0 6mm 0;
    color: #000;
  }
  .center { text-align: center; }
  .hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row-between { display: flex; justify-content: space-between; }
  .biz-name { font-size: 15px; font-weight: bold; text-align: center; line-height: 1.3; }
  .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; margin-top: 3px; }
</style>
</head>
<body>
  <div class="biz-name">LEYBLE GENERAL MERCHANDISE</div>
  <div class="center" style="font-size:10px;margin-top:2px">
    0917-860-5512 / 0955-330-3407 / 0919-004-4652
  </div>

  <div class="hr"></div>

  <div style="font-weight:bold;font-size:13px">${isPickupOrder ? 'PICKUP RECEIPT' : 'DELIVERY RECEIPT'}</div>
  <div class="row-between" style="margin-top:2px">
    <span>No: ${receiptNo}</span>
    <span>${dateStr} ${timeStr}</span>
  </div>
  ${soldBy ? `<div style="margin-top:2px">Sold by: ${soldBy}</div>` : ''}

  <div class="hr"></div>

  <div><strong>${isPickupOrder ? 'Received by' : 'Delivered to'}:</strong> ${order.customer_name}</div>
  ${order.customer_address ? `<div><strong>Address:</strong> ${order.customer_address}</div>` : ''}
  ${personnelLine}
  ${notesLine}

  <div class="hr"></div>

  ${itemRows}

  <div class="hr"></div>

  ${totalCasesRow}
  ${subtotalRows}
  <div class="total-row">
    <span>${printHasSubtotals ? 'FINAL TOTAL' : 'TOTAL'}</span>
    <span>${PHP(printTotal)}</span>
  </div>

  <div>&nbsp;</div>
  <div>&nbsp;</div>
  <div>&nbsp;</div>
  <div>&nbsp;</div>
  <div>&nbsp;</div>
  <div>&nbsp;</div>

  <div class="hr"></div>

  <div style="font-size:8px;line-height:1.2;margin-top:2px">
    <strong>TERMS:</strong> 18% interest per annum will be charged to vendee on all overdue
    accounts plus 25% of the amount due as attorney&#39;s fee in case of legal action that may arise
    out of the transaction and the venue shall be in Antipolo City
  </div>

  <div class="center" style="font-size:10px;margin-top:10px">
    Received the above merchandise<br>in good order and condition
  </div>
  <div style="border-top:1px solid #000;margin-top:24px;padding-top:2px;font-size:10px">By:</div>
</body>
</html>`;
}
