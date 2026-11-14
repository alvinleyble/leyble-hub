import { normalize } from './productSearch';
import { parseCustomerEntry } from './customerEntry';

// Order entry also understands the same name / note shorthand as quick-create.
// Keep this separate so directory searches and the merge tool are unchanged.
export function orderCustomerMatches(customer, query) {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return false;
  // Historical customers may still hold the whole shorthand in their name.
  if (customer.name.toLowerCase().includes(text)) return true;
  const { name, address } = parseCustomerEntry(query);
  if (!name) return false;
  if (address) {
    return customer.name.toLowerCase().includes(name.toLowerCase()) &&
      (customer.address ?? '').toLowerCase().includes(address.toLowerCase());
  }
  return customerMatches(customer, name);
}

// Exact identity for the order picker's Create guard, not the directory's
// duplicate/merge tools. A different delivery note can mean a different customer.
export function isExistingOrderCustomer(customer, query) {
  const text = String(query ?? '').trim().toLowerCase();
  const heldName = customer.name.trim().toLowerCase();
  if (heldName === text) return true; // includes legacy slash-names and plain names
  const { name, address } = parseCustomerEntry(query);
  return heldName === name.toLowerCase() &&
    (!address || (customer.address ?? '').trim().toLowerCase() === address.toLowerCase());
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
