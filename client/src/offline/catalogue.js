import { nativeStore } from './nativeStore.js';
import { PRODUCTS_KEY, CUSTOMERS_KEY, PERSONNEL_KEY, customerPricesKey } from './keys.js';
import { api } from '../api/client.js';

// D16 — the tablet sells only what it already holds.
//
// The catalogue (products, customers, personnel) refreshes quietly whenever the tablet
// is online, into native storage (D17). No staleness warning, no age indicator, nothing
// shown — the owners are never told how old the copy is. When the live fetch fails,
// order creation falls back to this held copy and keeps selling. A product added while
// the tablet was blind cannot be sold until the line returns — accepted (D16).
//
// Whole-value keys, not one key per item: unlike the outbox and order history (D9/D17),
// this is reference data the server sends in full, not built up locally record by
// record, so there is nothing to lose from a torn write beyond one refresh cycle.
//
// ADR 0015 §9 adds personnel to the same store, because Driver/Helper assignment in
// OrderCreateModal is part of taking an order and must work blind like the rest of it.
//
// Two shapes of refresh live here, and they are not interchangeable:
//   refreshCatalogue()  — the FULL pull. Every row, active and inactive. Used once,
//                         on a tablet that holds nothing yet (sync.js's first setup).
//   applyCatalogueDelta()— the INCREMENTAL merge. Only rows the server says changed
//                         since our last sync, merged onto what we already hold. This
//                         is what a normal daily login and every reconnect do.
// The cache deliberately holds INACTIVE rows too: a deactivation is a change we have
// to be able to learn about from a delta (soft delete bumps `updated_at`), and the
// readers below filter to active themselves, so the shape callers see is unchanged.

const ENTITY_KEYS = {
  products:  PRODUCTS_KEY,
  customers: CUSTOMERS_KEY,
  personnel: PERSONNEL_KEY,
};

const ENTITY_ENDPOINTS = {
  products:  '/products',
  customers: '/customers',
  personnel: '/personnel',
};

const activeOnly = (rows) => rows.filter((r) => r?.is_active !== false);

async function readCached(entity) {
  return (await nativeStore.getJson(ENTITY_KEYS[entity])) || [];
}

export async function getCachedProducts()  { return activeOnly(await readCached('products')); }
export async function getCachedCustomers() { return activeOnly(await readCached('customers')); }
export async function getCachedPersonnel() { return activeOnly(await readCached('personnel')); }

// Everything held for an entity, inactive rows included — what the delta merge works
// against, and what a caller that genuinely needs the full roster (an order referencing
// a since-deactivated driver) can read.
export async function getCachedEntity(entity) {
  return readCached(entity);
}

/**
 * Full pull of one reference entity, inactive rows included. Replaces the held copy
 * outright — correct only because the server answers with the complete set.
 */
export async function refreshEntity(entity) {
  const rows = await api.get(`${ENTITY_ENDPOINTS[entity]}?include_inactive=true`);
  const list = Array.isArray(rows) ? rows : [];
  await nativeStore.setJson(ENTITY_KEYS[entity], list);
  return list;
}

/**
 * Merges a server delta (rows changed since `since`) onto the held copy, by id.
 *
 * Merge, never replace: a delta is by definition a fragment, so writing it over the
 * cache would leave the tablet holding LESS than it did before the sync — the exact
 * failure the interrupted-sync rule exists to prevent. A row present in the delta wins
 * over the held one (that is what "changed" means); everything else is left alone.
 */
export async function applyCatalogueDelta(entity, changedRows) {
  const rows = Array.isArray(changedRows) ? changedRows : [];
  if (rows.length === 0) return readCached(entity);

  const held = await readCached(entity);
  const byId = new Map(held.map((r) => [String(r.id), r]));
  for (const row of rows) {
    if (row?.id === undefined || row?.id === null) continue;
    byId.set(String(row.id), row);
  }
  const merged = [...byId.values()];
  await nativeStore.setJson(ENTITY_KEYS[entity], merged);
  return merged;
}

async function refreshCatalogue() {
  const [products, customers, personnel] = await Promise.all([
    refreshEntity('products'),
    refreshEntity('customers'),
    refreshEntity('personnel'),
  ]);
  return { products, customers, personnel };
}

/**
 * Loads the catalogue for order creation: tries the live server first (and quietly
 * refreshes the held copy on success), and falls back to whatever this device already
 * holds when the server cannot be reached. Never throws — a brand-new device with an
 * empty cache and no connectivity yet is the one corner D16 explicitly accepts (it
 * simply cannot sell, same as it has nothing to number a receipt with either, D1).
 *
 * Returns ACTIVE rows only, which is what every picker in the app wants; the held copy
 * underneath keeps the inactive ones so a delta can still learn about reactivation.
 */
export async function loadCatalogue() {
  try {
    const { products, customers, personnel } = await refreshCatalogue();
    return {
      products:  activeOnly(products),
      customers: activeOnly(customers),
      personnel: activeOnly(personnel),
      fromCache: false,
    };
  } catch {
    const [products, customers, personnel] = await Promise.all([
      getCachedProducts(), getCachedCustomers(), getCachedPersonnel(),
    ]);
    return { products, customers, personnel, fromCache: true };
  }
}

// Saved custom prices (ADR 0009's pricing source) — cached per (customer, order_type),
// not swept in with the whole-catalogue refresh above. There is no bulk "all saved
// prices" endpoint, and the store has ~141 accounts across two order types each;
// fetching all of it on every quiet refresh would mean hundreds of requests for rates
// most of which will never be sold against before the next refresh. Instead the cache
// fills in lazily, the same shape as the live read it replaces: whichever customer/
// order_type combination order creation actually asks for gets written to native
// storage at that moment, so the accounts a device has genuinely been selling to are
// exactly the ones it can still price correctly the next time it goes blind.

export async function getCachedCustomerPrices(customerId, orderType) {
  return (await nativeStore.getJson(customerPricesKey(customerId, orderType))) || [];
}

/**
 * Loads saved prices for one customer/order_type: tries the live server first (and
 * quietly refreshes the held copy on success), and falls back to whatever this device
 * already holds for that pair when the server cannot be reached. Never throws — same
 * contract as loadCatalogue above.
 */
export async function loadCustomerPrices(customerId, orderType) {
  try {
    const prices = await api.get(`/customers/${customerId}/prices?order_type=${orderType}`);
    await nativeStore.setJson(customerPricesKey(customerId, orderType), prices);
    return { prices, fromCache: false };
  } catch {
    const prices = await getCachedCustomerPrices(customerId, orderType);
    return { prices, fromCache: true };
  }
}
