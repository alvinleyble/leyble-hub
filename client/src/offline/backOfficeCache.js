import { nativeStore } from './nativeStore.js';
import { backOfficeKey } from './keys.js';

// ADR 0015 §9 — quiet reference caching for the back-office screens.
//
// Dashboard, Tickets, the Incoming Supplies list and the two Audit feeds are things
// the owners READ. None of them is built up locally record by record the way the
// outbox and the order history are, so each caches as one whole value under
// `v25.cache.<name>` — the same reasoning as the catalogue (see catalogue.js), and
// the same tolerance for a torn write costing one refresh cycle and nothing else.
//
// Two rules make this different from the catalogue, though:
//
//  1. **The copy's age is shown.** D16's "never tell them how old the catalogue is"
//     is a rule about SELLING: a price is a price and a staleness warning next to it
//     only makes an operator hesitate. A back-office FIGURE is the opposite — "₱48,200
//     in transit" is meaningless without knowing when it was true — so every cached
//     value is wrapped in `{ cached_at, value }` and the banner names the timestamp.
//
//  2. **Only the UNFILTERED load is cached.** Every one of these screens has filters
//     (ticket status, audit product/date, delivery supplier/date), and caching per
//     filter combination would fragment the copy into whichever slices the owner
//     happened to look at last. Instead the baseline — no filters — is what gets
//     written, and offline the callers filter that copy on the client. What the owner
//     loses blind is reach beyond the cached window, never correctness of what shows.
//
// Windows are bounded per caller (see CACHE_LIMITS): this is reference data for
// looking things up during an outage, not a second copy of the database. Order
// history is the one thing with no age limit (ADR 0015 §4), and it lives in
// receiptHistory.js, not here.

export const DASHBOARD_CACHE   = 'dashboard';
export const TICKETS_CACHE     = 'tickets';
export const DELIVERIES_CACHE  = 'deliveries';
export const AUDIT_INVENTORY_CACHE = 'audit.inventory';
export const AUDIT_ACTIVITY_CACHE  = 'audit.activity';

// Row caps per cached list. Deliberately generous enough that an outage never runs
// off the end of what the owner would plausibly scroll, and small enough that the
// whole back-office cache stays a rounding error next to the order history.
export const CACHE_LIMITS = {
  [TICKETS_CACHE]:     300,
  [DELIVERIES_CACHE]:  300,
  [AUDIT_INVENTORY_CACHE]: 300,
  [AUDIT_ACTIVITY_CACHE]:  300,
};

// Age caps, applied on top of the row cap where the row carries a timestamp. Audit
// gets the wider window because it is the screen owners reach for when reconstructing
// what happened; deliveries the narrower one because a restock older than a month is
// history rather than something being checked against a truck on the forecourt.
export const CACHE_MAX_AGE_DAYS = {
  [DELIVERIES_CACHE]:      30,
  [AUDIT_INVENTORY_CACHE]: 90,
  [AUDIT_ACTIVITY_CACHE]:  90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function withinAge(row, days, field) {
  if (!days) return true;
  const at = row?.[field];
  if (!at) return true; // no timestamp to judge by — keep it rather than guess
  const t = Date.parse(at);
  return Number.isNaN(t) ? true : (Date.now() - t) <= days * DAY_MS;
}

/**
 * Trims a list to this cache's bounded window before it is written. Rows are assumed
 * to arrive newest-first (every one of these endpoints orders that way).
 */
export function boundRows(name, rows, { dateField = 'created_at' } = {}) {
  if (!Array.isArray(rows)) return rows;
  const days = CACHE_MAX_AGE_DAYS[name];
  const limit = CACHE_LIMITS[name];
  let out = days ? rows.filter((r) => withinAge(r, days, dateField)) : rows;
  if (limit && out.length > limit) out = out.slice(0, limit);
  return out;
}

export async function writeBackOfficeCache(name, value) {
  await nativeStore.setJson(backOfficeKey(name), { cached_at: new Date().toISOString(), value });
  return value;
}

/**
 * @returns {Promise<{value:any, cachedAt:string}|null>} null when nothing is held.
 */
export async function readBackOfficeCache(name) {
  const held = await nativeStore.getJson(backOfficeKey(name));
  if (!held || held.value === undefined) return null;
  return { value: held.value, cachedAt: held.cached_at || null };
}

/**
 * The one call every back-office loader makes.
 *
 * Live first (and quietly refresh the held copy on success); on ANY failure fall back
 * to whatever this device holds. Never throws when a cache exists — the screen simply
 * renders the older copy behind its banner. With no cache at all it re-throws the
 * original error, so the caller can show its own "connect once" empty state rather
 * than a blank screen pretending to be up to date.
 *
 * `cacheable` is what gets WRITTEN — pass `false` when the live call carried filters,
 * so a filtered response never overwrites the unfiltered baseline (see rule 2 above).
 *
 * @param {string}   name       one of the *_CACHE constants
 * @param {Function} fetcher    () => Promise<any>
 * @param {object}  [opts]
 * @param {boolean} [opts.cacheable=true]  write the result to the cache
 * @param {string}  [opts.dateField]       row timestamp used for the age cap
 * @returns {Promise<{data:any, fromCache:boolean, cachedAt:string|null}>}
 */
export async function loadWithCache(name, fetcher, { cacheable = true, dateField } = {}) {
  try {
    const data = await fetcher();
    if (cacheable) await writeBackOfficeCache(name, boundRows(name, data, { dateField }));
    return { data, fromCache: false, cachedAt: null };
  } catch (err) {
    const held = await readBackOfficeCache(name);
    if (!held) throw err;
    return { data: held.value, fromCache: true, cachedAt: held.cachedAt };
  }
}

// Test seam.
export async function __clearBackOfficeCache() {
  for (const name of [DASHBOARD_CACHE, TICKETS_CACHE, DELIVERIES_CACHE,
                      AUDIT_INVENTORY_CACHE, AUDIT_ACTIVITY_CACHE]) {
    await nativeStore.remove(backOfficeKey(name));
  }
}
