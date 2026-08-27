import { normalize } from './productSearch';

// Customer matcher for the V2 POS customer search bar. Same punctuation-insensitive
// idea as productMatches: "sm mart" finds "S.M. Mart", "7eleven" finds "7-Eleven".
// Name, address and phone all match, and an empty query returns everything so the
// bar opens on the full list.
export function customerMatches(customer, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const qNorm = normalize(q);
  return (
    customer.name.toLowerCase().includes(q) ||
    (qNorm !== '' && normalize(customer.name).includes(qNorm)) ||
    (customer.address ?? '').toLowerCase().includes(q) ||
    (qNorm !== '' && normalize(customer.phone).includes(qNorm))
  );
}
