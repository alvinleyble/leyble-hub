import { normalize } from './productSearch';

/**
 * Normalizes both name and address for composite matching.
 * Returns null if name or address is blank or missing.
 */
function compositeKey(customer) {
  if (!customer || !customer.name || customer.is_active === false) return null;
  const normName = normalize(customer.name);
  const normAddress = normalize(customer.address);
  // Captain rule: missing/blank address does NOT match, so incomplete records never pair.
  if (!normName || !normAddress) return null;
  return `${normName}:::${normAddress}`;
}

/**
 * Finds groups of potential duplicate customers using punctuation-insensitive
 * normalization on BOTH Name and Address (D4).
 *
 * Real customers may share names, so a duplicate is flagged only when both name
 * AND address match. Blank addresses never match.
 *
 * @param {Array<object>} customers List of customer objects
 * @returns {Record<string, Array<object>>} Map of compositeKey -> Array of duplicate customers (groups with length >= 2)
 */
export function findDuplicateCustomerGroups(customers = []) {
  const groups = {};

  for (const customer of customers) {
    const key = compositeKey(customer);
    if (!key) continue;

    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(customer);
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
 * Given a customer and the full customer list, returns potential duplicate candidates
 * matching both name and address.
 *
 * @param {object} customer
 * @param {Array<object>} customers
 * @returns {Array<object>}
 */
export function getDuplicateCandidatesFor(customer, customers = []) {
  const key = compositeKey(customer);
  if (!key) return [];

  return customers.filter(
    (c) => c && c.is_active !== false && String(c.id) !== String(customer.id) && compositeKey(c) === key
  );
}
