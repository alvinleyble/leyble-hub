// ESC/POS generators for the Product price list and Customer list (80mm, 48 chars/line).
// Sent directly to a Bluetooth thermal printer on Android — mirrors orders/escposReceipt.js.

const W   = 48;
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

function fmtMoney(n) {
  const num = Number(n) || 0;
  const s = Math.abs(num).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return 'PHP' + s;
}

function padLR(left, right, w = W) {
  const gap = w - left.length - right.length;
  return left + ' '.repeat(Math.max(1, gap)) + right;
}

function wrap(text, w = W) {
  const words = String(text).split(' ');
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

function makeWriter() {
  const buf = [];
  const b   = (...bytes) => { for (const v of bytes) buf.push(v); };
  const s   = (str) => { for (let i = 0; i < str.length; i++) buf.push(str.charCodeAt(i) & 0xFF); };
  const ln  = (str = '') => { s(str); b(LF); };
  const hr  = () => ln('-'.repeat(W));
  return { buf, b, s, ln, hr };
}

function header(w, title, countLine, dateStr) {
  const { b, ln, hr } = w;
  b(ESC, 0x40);          // init
  b(ESC, 0x61, 0x01);    // center
  b(ESC, 0x45, 0x01);    // bold on
  b(GS,  0x21, 0x10);    // double-width
  ln('LEYBLE GENERAL');
  ln('MERCHANDISE');
  b(GS,  0x21, 0x00);    // normal
  b(ESC, 0x45, 0x00);    // bold off
  ln(title);
  b(ESC, 0x61, 0x00);    // left
  hr();
  ln(padLR(countLine, dateStr));
  hr();
}

function footer(w) {
  const { b, ln } = w;
  ln();
  b(ESC, 0x61, 0x01);    // center
  ln('-- end of list --');
  b(ESC, 0x61, 0x00);    // left
  b(ESC, 0x64, 0x04);    // feed 4 lines
  b(GS,  0x56, 0x41, 0x03); // partial cut
}

function dateStr() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

export function productListEscPos(products) {
  const active = (products || []).filter((p) => p.is_active !== false);

  const groups = {};
  for (const p of active) {
    const cat = p.category || 'Uncategorised';
    (groups[cat] ||= []).push(p);
  }
  const cats = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const w = makeWriter();
  const { b, ln } = w;
  header(w, 'PRODUCT PRICE LIST',
    `${active.length} item${active.length === 1 ? '' : 's'}`, dateStr());

  for (const cat of cats) {
    const items = groups[cat].sort((a, b2) => (a.sku || a.name).localeCompare(b2.sku || b2.name));
    b(ESC, 0x45, 0x01);
    ln(cat.toUpperCase());
    b(ESC, 0x45, 0x00);
    for (const p of items) {
      b(ESC, 0x45, 0x01);
      for (const l of wrap(p.sku || p.name)) ln(l);
      b(ESC, 0x45, 0x00);
      if (p.sku) for (const l of wrap(`  ${p.name}`)) ln(l);
      ln(padLR('  Price/case', fmtMoney(p.base_wholesale_price)));
      if (p.requires_bottle_return) ln(padLR('  Deposit/btl', fmtMoney(p.deposit_fee)));
      ln(padLR('  Stock', `${Number(p.current_stock)} cs`));
    }
    ln();
  }

  footer(w);
  return new Uint8Array(w.buf);
}

export function productCountSheetEscPos(products) {
  const active = (products || []).filter((p) => p.is_active !== false);

  const groups = {};
  for (const p of active) {
    const cat = p.category || 'Uncategorised';
    (groups[cat] ||= []).push(p);
  }
  const cats = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const w = makeWriter();
  const { b, ln } = w;
  header(w, 'PHYSICAL STOCK COUNT SHEET',
    `${active.length} item${active.length === 1 ? '' : 's'}`, dateStr());

  for (const cat of cats) {
    const items = groups[cat].sort((a, b2) => (a.sku || a.name).localeCompare(b2.sku || b2.name));
    b(ESC, 0x45, 0x01);
    ln(cat.toUpperCase());
    b(ESC, 0x45, 0x00);
    for (const p of items) {
      b(ESC, 0x45, 0x01);
      for (const l of wrap(p.sku || p.name)) ln(l);
      b(ESC, 0x45, 0x00);
      if (p.sku) for (const l of wrap(`  ${p.name}`)) ln(l);
      ln(padLR('  System stock', `${Number(p.current_stock)} ${p.unit}`));
      ln(padLR('  Counted', '________'));
    }
    ln();
  }

  ln('Counted by: _______________________');
  ln();
  ln('Checked by: _______________________');

  footer(w);
  return new Uint8Array(w.buf);
}

export function customerListEscPos(customers) {
  const active = (customers || []).filter((c) => c.is_active !== false)
    .sort((a, b2) => a.name.localeCompare(b2.name));

  const w = makeWriter();
  const { b, ln } = w;
  header(w, 'CUSTOMER LIST',
    `${active.length} customer${active.length === 1 ? '' : 's'}`, dateStr());

  for (const c of active) {
    b(ESC, 0x45, 0x01);
    for (const l of wrap(c.name)) ln(l);
    b(ESC, 0x45, 0x00);
    ln(`  ${c.customer_type === 'wholesaler' ? 'Wholesaler' : c.customer_type === 'discounted' ? 'Discounted' : c.customer_type === 'markup' ? 'Markup' : c.customer_type === 'unassigned' ? 'Unassigned' : 'Regular'}`);
    if (c.address) for (const l of wrap(`  ${c.address}`)) ln(l);
    ln();
  }

  footer(w);
  return new Uint8Array(w.buf);
}
