import { bottleCredit, bottlesReturned, countsReturns } from './bottleReturns.js';

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
  const isPickupOrder = order.order_type === 'pickup';
  // The listed price already includes the deposit (bottleReturns.js). Only the closing
  // receipt (completed/done) counts returns, as one credit line under the product.
  const showReturns = countsReturns(order.status);
  const creditFor = (item) => (showReturns ? bottleCredit(item, returnCounts) : 0);

  const printItemsTotal   = order.items.reduce(
    (s, i) => s + Number(i.quantity) * Number(i.unit_price) - creditFor(i), 0);
  // persistent-delivery-fee.md decision 4: unset means the line doesn't exist, not
  // ₱0.00 — a deliberately-configured ₱0.00 still prints its own line.
  const hasDeliveryFee    = order.delivery_fee_charged !== null && order.delivery_fee_charged !== undefined;
  const printDeliveryFee  = hasDeliveryFee ? Number(order.delivery_fee_charged) : 0;
  const printAdj          = Number(
    overrides.adjustment !== undefined ? overrides.adjustment : (order.adjustment || 0)
  ) || 0;
  const printAdjReason    = overrides.adjustment_reason !== undefined
    ? overrides.adjustment_reason
    : order.adjustment_reason;
  // Decision 12: delivery fee joins the total ahead of the adjustment term.
  const printTotal        = printItemsTotal + printDeliveryFee + printAdj;
  const printHasSubtotals = hasDeliveryFee || printAdj !== 0;
  const printTotalCases   = order.items.reduce((s, i) => s + Number(i.quantity), 0);

  const itemRows = order.items.map((item) => {
    const qty      = Number(item.quantity);
    const displayTotal = qty * Number(item.unit_price);

    // Nothing extra when no bottles came back: the listed price already holds the deposit.
    const credit = creditFor(item);
    const depLine = credit > 0
      ? `<div style="display:flex;justify-content:space-between;margin-top:1px">
           <span>&nbsp;&nbsp;Bottles returned ${bottlesReturned(item, returnCounts)} &times; ${PHP(item.unit_deposit_fee)}</span>
           <span>-${PHP(credit)}</span>
         </div>`
      : '';
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
    </div>${hasDeliveryFee ? `
    <div class="row-between">
      <span>Delivery Fee</span><span>${PHP(printDeliveryFee)}</span>
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
  .thanks { margin-top: 2px; }
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

  <div class="center thanks">
    Thank you for your business!
  </div>
</body>
</html>`;
}
