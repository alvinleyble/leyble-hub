// 80mm print templates for the Product price list and Customer list.
// Mirrors the receipt look (orders/receiptTemplate.js): 72mm body, monospace,
// LEYBLE GENERAL MERCHANDISE header. Used by usePrintList on web (window.print).

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const todayStr = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};

// Escape user-supplied text so names/addresses can't break the markup.
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HEAD = (title) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
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
  .doc-title { font-weight: bold; font-size: 13px; }
  .cat { font-weight: bold; text-decoration: underline; margin-top: 8px; margin-bottom: 2px; }
  .entry { margin-bottom: 6px; }
  .name { font-weight: bold; }
  .sub { font-size: 10px; color: #333; }
</style>
</head>
<body>
  <div class="biz-name">LEYBLE GENERAL MERCHANDISE</div>`;

const FOOT = `
</body>
</html>`;

// ── Product price list ────────────────────────────────────────────────────────
export function productListHtml(products) {
  const active = (products || []).filter((p) => p.is_active !== false);

  const groups = {};
  for (const p of active) {
    const cat = p.category || 'Uncategorised';
    (groups[cat] ||= []).push(p);
  }
  const cats = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const body = cats.map((cat) => {
    const items = groups[cat].sort((a, b) =>
      (a.sku || a.name).localeCompare(b.sku || b.name));
    const rows = items.map((p) => `
    <div class="entry">
      <div class="name">${esc(p.sku || p.name)}</div>
      ${p.sku ? `<div class="sub">${esc(p.name)}</div>` : ''}
      <div class="row-between"><span>Price/case</span><span>${PHP(p.base_wholesale_price)}</span></div>
      ${p.requires_bottle_return
        ? `<div class="row-between"><span>Deposit/btl</span><span>${PHP(p.deposit_fee)}</span></div>`
        : ''}
      <div class="row-between"><span>Stock</span><span>${Number(p.current_stock)} cs</span></div>
    </div>`).join('');
    return `<div class="cat">${esc(cat)}</div>${rows}`;
  }).join('');

  return `${HEAD('Product Price List')}
  <div class="center" style="font-size:10px;margin-top:2px">PRODUCT PRICE LIST</div>
  <div class="row-between" style="font-size:10px;margin-top:2px">
    <span>${active.length} item${active.length === 1 ? '' : 's'}</span>
    <span>${todayStr()}</span>
  </div>
  <div class="hr"></div>
  ${body || '<div class="center">No products.</div>'}
  <div class="hr"></div>
  <div class="center" style="font-size:10px">— end of list —</div>${FOOT}`;
}

// ── Customer list ─────────────────────────────────────────────────────────────
export function customerListHtml(customers) {
  const active = (customers || []).filter((c) => c.is_active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  const body = active.map((c) => `
  <div class="entry">
    <div class="name">${esc(c.name)}</div>
    <div class="sub">${c.customer_type === 'wholesaler' ? 'Wholesaler' : 'Regular'}</div>
    ${c.address ? `<div>${esc(c.address)}</div>` : ''}
  </div>`).join('');

  return `${HEAD('Customer List')}
  <div class="center" style="font-size:10px;margin-top:2px">CUSTOMER LIST</div>
  <div class="row-between" style="font-size:10px;margin-top:2px">
    <span>${active.length} customer${active.length === 1 ? '' : 's'}</span>
    <span>${todayStr()}</span>
  </div>
  <div class="hr"></div>
  ${body || '<div class="center">No customers.</div>'}
  <div class="hr"></div>
  <div class="center" style="font-size:10px">— end of list —</div>${FOOT}`;
}
