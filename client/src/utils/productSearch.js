// Smart product matcher shared by every product search bar.
// Dashes/spaces/punctuation are ignored when matching SKUs, so "c8" finds
// "C-8", "cxl" finds "C-XL", "cm" finds "C-M". Name and category match as
// plain substrings (and also punctuation-insensitively), so typing "Mismo"
// surfaces every Mismo product (C-M, S-M, R-M, …) by name.
const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function productMatches(product, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const qNorm = normalize(q);
  return (
    (qNorm !== '' && normalize(product.sku).includes(qNorm)) ||
    product.name.toLowerCase().includes(q) ||
    (qNorm !== '' && normalize(product.name).includes(qNorm)) ||
    (product.category ?? '').toLowerCase().includes(q)
  );
}
