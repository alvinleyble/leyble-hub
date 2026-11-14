import { normalize } from './productSearch';
import { parseCustomerEntry } from './customerEntry';

// Order entry also understands the same name / note shorthand as quick-create.
// Keep this separate so the directory, duplicate check and merge tool are unchanged.
export function orderCustomerMatches(customer, query) {
  const { name, address } = parseCustomerEntry(query);
  if (!name) return false;
  if (address) {
    return customer.name.toLowerCase().includes(name.toLowerCase()) &&
      (customer.address ?? '').toLowerCase().includes(address.toLowerCase());
  }
  return customerMatches(customer, name);
}

// Directory/merge search: "sm mart" finds "S.M. Mart", "7eleven" finds "7-Eleven".
// Name, address and phone all match; an empty query returns everything.
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
