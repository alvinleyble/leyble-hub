import { nativeStore } from './nativeStore.js';
import { NS } from './keys.js';
import { api } from '../api/client.js';

// D16 — the tablet sells only what it already holds.
//
// The catalogue (products, customers) refreshes quietly whenever the tablet is
// online, into native storage (D17). No staleness warning, no age indicator, nothing
// shown — the owners are never told how old the copy is. When the live fetch fails,
// the POS falls back to this held copy and keeps selling. A product added while the
// tablet was blind cannot be sold until the line returns — accepted (D16).
//
// Whole-catalogue replace, not one key per item: unlike the outbox and receipt
// history (D9/D17), this is reference data the server always sends in full, not
// built up locally record by record, so there is nothing to lose from a torn write
// beyond one refresh cycle.

const PRODUCTS_KEY  = `${NS}catalogue.products`;
const CUSTOMERS_KEY = `${NS}catalogue.customers`;

export async function getCachedProducts() {
  return (await nativeStore.getJson(PRODUCTS_KEY)) || [];
}

export async function getCachedCustomers() {
  return (await nativeStore.getJson(CUSTOMERS_KEY)) || [];
}

async function refreshCatalogue() {
  const [products, customers] = await Promise.all([
    api.get('/products'),
    api.get('/customers'),
  ]);
  await nativeStore.setJson(PRODUCTS_KEY, products);
  await nativeStore.setJson(CUSTOMERS_KEY, customers);
  return { products, customers };
}

/**
 * Loads the catalogue for the POS: tries the live server first (and quietly refreshes
 * the held copy on success), and falls back to whatever this device already holds
 * when the server cannot be reached. Never throws — a brand-new device with an empty
 * cache and no connectivity yet is the one corner D16 explicitly accepts (it simply
 * cannot sell, same as it has nothing to number a receipt with either, D1).
 */
export async function loadCatalogue() {
  try {
    const { products, customers } = await refreshCatalogue();
    return { products, customers, fromCache: false };
  } catch {
    const [products, customers] = await Promise.all([getCachedProducts(), getCachedCustomers()]);
    return { products, customers, fromCache: true };
  }
}
