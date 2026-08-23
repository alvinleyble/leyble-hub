import { normalize } from './productSearch';

/**
 * Finds groups of potential duplicate customers using punctuation-insensitive
 * normalization (D4).
 *
 * "Aling Nena" vs "Aling Nena", "S.M. Mart" vs "SM Mart", "7-Eleven" vs "7 Eleven"
 * normalize to the same string and are flagged as potential duplicates.
 *
 * @param {Array<object>} customers List of customer objects
 * @returns {Record<string, Array<object>>} Map of normalizedName -> Array of duplicate customers (groups with length >= 2)
 */
export function findDuplicateCustomerGroups(customers = []) {
  const groups = {};

  for (const customer of customers) {
    if (!customer || !customer.name || customer.is_active === false) continue;
    const norm = normalize(customer.name);
    if (!norm) continue;

    if (!groups[norm]) {
      groups[norm] = [];
    }
    groups[norm].push(customer);
  }

  const duplicates = {};
  for (const [key, group] of Object.entries(groups)) {
    if (group.length > 1) {
      duplicates[key] = group;
    }
  }

  return duplicates;
}

/**
 * Returns a Set of customer IDs that are flagged as potential duplicates.
 *
 * @param {Array<object>} customers
 * @returns {Set<number|string>}
 */
export function getDuplicateCustomerIds(customers = []) {
  const duplicateGroups = findDuplicateCustomerGroups(customers);
  const ids = new Set();
  for (const group of Object.values(duplicateGroups)) {
    for (const c of group) {
      ids.add(c.id);
    }
  }
  return ids;
}

/**
 * Returns the count of customers that are potential duplicates.
 *
 * @param {Array<object>} customers
 * @returns {number}
 */
export function countDuplicateCustomers(customers = []) {
  return getDuplicateCustomerIds(customers).size;
}

/**
 * Given a customer and the full customer list, returns potential duplicate candidates.
 *
 * @param {object} customer
 * @param {Array<object>} customers
 * @returns {Array<object>}
 */
export function getDuplicateCandidatesFor(customer, customers = []) {
  if (!customer || !customer.name) return [];
  const norm = normalize(customer.name);
  if (!norm) return [];

  return customers.filter(
    (c) => c && c.is_active !== false && String(c.id) !== String(customer.id) && normalize(c.name) === norm
  );
}
