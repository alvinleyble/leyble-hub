// V3.0 Slice 3.3 — back-office read-only caching, offline product/stock CRUD with
// human reconciliation, and offline incoming-delivery logging (ADR 0015 §§6, 8, 9).
//
// What this slice changed, and therefore what is worth pinning here:
//   * back-office screens read from a bounded local copy instead of showing a raw
//     fetch failure (Dashboard, Tickets, Audit, Incoming)
//   * product create / edit / stock adjust / batch reprice all go through the outbox
//   * §6's hard requirement: NO silent last-write-wins on a contested stock count or
//     price — and, just as important, no false alarm when the server's number moved
//     only because something was sold or delivered
//   * deliveries carry a device-issued `<station>-DEL-<seq>` reference so a resend
//     cannot become a second truckload of stock
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { __clearOutbox, listRecords, enqueue, drainOutbox } from '../src/offline/outbox.js';
import { __resetIssuance, ensureStationRegistered, issueDeliveryRef } from '../src/offline/station.js';
import { formatDeliveryRef, parseDeliveryRef } from '../src/offline/receiptNumbers.js';
import {
  loadWithCache, boundRows, readBackOfficeCache, __clearBackOfficeCache,
  DASHBOARD_CACHE, TICKETS_CACHE, DELIVERIES_CACHE, AUDIT_INVENTORY_CACHE,
} from '../src/offline/backOfficeCache.js';
import {
  listConflicts, __clearConflicts, STOCK_FIELD, PRICE_FIELD,
} from '../src/offline/reconcile.js';
import {
  createProductLocalFirst, updateProductLocalFirst, batchPriceLocalFirst,
  screenProductMutations, resolveConflict, keepServerValue, queuedProductsFromOutbox,
  findCompetingEdit,
} from '../src/offline/productMutations.js';
import {
  logDeliveryLocalFirst, queuedDeliveriesFromOutbox, mergeDeliveries,
} from '../src/offline/deliveries.js';
import { applyCatalogueDelta, getCachedProducts, getCachedCustomers } from '../src/offline/catalogue.js';
import { updateCustomerLocalFirst } from '../src/offline/queuedCustomers.js';

const { createRoot } = await import('react-dom/client');

const DashboardPage = (await import('../src/pages/DashboardPage.jsx')).default;
const TicketsPage   = (await import('../src/pages/tickets/TicketsPage.jsx')).default;

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function renderPage(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(ToastProvider, null, element)));
  });
  return {
    container,
    text: () => container.textContent,
    all: (sel) => [...container.querySelectorAll(sel)],
    unmount: () => act(() => { root.unmount(); }),
  };
}

const offline = () => { const e = new Error('Failed to fetch'); return e; };

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  await __clearConflicts();
  await __clearBackOfficeCache();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRODUCT = {
  id: 1, name: 'Red Horse 500ml', sku: 'RH-5', category: 'Beer', unit: 'cs',
  base_wholesale_price: 900, deposit_fee: 5, current_stock: 20, units_per_case: 24,
  requires_bottle_return: true, is_active: true,
};

const auditEntry = (over = {}) => ({
  id: 1, action_type: 'manual_adjustment', field_changed: 'current_stock',
  previous_value: '20', new_value: '40', delta: 20, reason: 'Physical count',
  created_at: '2026-08-29T10:00:00.000Z', ...over,
});

async function seedCatalogue(products = [PRODUCT]) {
  await applyCatalogueDelta('products', products);
}

async function registerStation(number = 3) {
  api.post = async () => ({ slot_number: number, next_sequence: 1, registered_at: '2026-08-29T00:00:00.000Z' });
  await ensureStationRegistered();
}

// ── §9: back-office reference cache ──────────────────────────────────────────

test('§9: a back-office read caches its payload, and the next read falls back to it with the timestamp', async () => {
  const payload = { summary: { pending_count: 4 }, orders: [], low_stock: [] };
  const live = await loadWithCache(DASHBOARD_CACHE, async () => payload);
  assert.equal(live.fromCache, false);

  const blind = await loadWithCache(DASHBOARD_CACHE, async () => { throw offline(); });
  assert.equal(blind.fromCache, true);
  assert.deepEqual(blind.data, payload);
  assert.ok(blind.cachedAt, 'the copy names when it was true — §9 shows the age, D16 does not');
});

test('§9: with nothing held, a failed read rethrows rather than pretending to be up to date', async () => {
  await assert.rejects(
    () => loadWithCache(TICKETS_CACHE, async () => { throw offline(); }),
    /Failed to fetch/
  );
});

test('§9: a FILTERED read never overwrites the unfiltered baseline', async () => {
  await loadWithCache(TICKETS_CACHE, async () => [{ id: 1, status: 'pending' }, { id: 2, status: 'resolved' }]);
  await loadWithCache(TICKETS_CACHE, async () => [{ id: 2, status: 'resolved' }], { cacheable: false });

  const held = await readBackOfficeCache(TICKETS_CACHE);
  assert.equal(held.value.length, 2, 'the baseline survives a filtered read');
});

test('§9: the cached window is bounded by age and row count, not mirrored wholesale', async () => {
  const old = { id: 1, received_at: '2020-01-01T00:00:00.000Z' };
  const recent = { id: 2, received_at: new Date().toISOString() };
  const bounded = boundRows(DELIVERIES_CACHE, [recent, old], { dateField: 'received_at' });
  assert.deepEqual(bounded.map((r) => r.id), [2], 'a delivery older than the 30-day window is not held');

  const many = Array.from({ length: 400 }, (_, i) => ({ id: i, created_at: new Date().toISOString() }));
  assert.equal(boundRows(AUDIT_INVENTORY_CACHE, many).length, 300);
});

test('§9: the Dashboard renders cached figures behind a banner instead of a raw fetch failure', async () => {
  const payload = {
    summary: { in_transit_count: 2, pending_count: 7, completed_count: 1, pending_tickets: 0 },
    orders: [], low_stock: [],
  };
  api.get = async () => payload;
  const first = renderPage(React.createElement(DashboardPage));
  await settle();
  assert.match(first.text(), /Dashboard/);
  first.unmount();

  api.get = async () => { throw offline(); };
  const blind = renderPage(React.createElement(DashboardPage));
  await settle();
  assert.match(blind.text(), /Viewing offline data/);
  assert.match(blind.text(), /Go to Outgoing Orders/);
  assert.doesNotMatch(blind.text(), /Failed to fetch/);
  assert.match(blind.text(), /7/, 'the cached figures are actually shown, not just the banner');
  blind.unmount();
});

test('§9: with no cache at all the Dashboard shows a clean placeholder, never the fetch error', async () => {
  api.get = async () => { throw offline(); };
  const page = renderPage(React.createElement(DashboardPage));
  await settle();
  assert.doesNotMatch(page.text(), /Failed to fetch/);
  assert.match(page.text(), /no dashboard figures saved yet/);
  assert.match(page.text(), /Go to Outgoing Orders/);
  page.unmount();
});

test('§9: Tickets filters the cached copy on the client, so every tab works blind', async () => {
  const tickets = [
    { id: 1, title: 'Missing bottles', description: 'x', status: 'pending',  created_at: '2026-08-28T00:00:00.000Z' },
    { id: 2, title: 'Settled short',   description: 'y', status: 'resolved', created_at: '2026-08-27T00:00:00.000Z' },
  ];
  api.get = async () => tickets;
  const first = renderPage(React.createElement(TicketsPage));
  await settle();
  first.unmount();

  api.get = async () => { throw offline(); };
  const blind = renderPage(React.createElement(TicketsPage));
  await settle();
  assert.match(blind.text(), /Viewing offline data/);
  assert.match(blind.text(), /Missing bottles/, 'the default Pending tab reads from the cached copy');
  assert.doesNotMatch(blind.text(), /Settled short/, 'and the status filter still applies to it');
  blind.unmount();
});

test('§9: raising a ticket is blocked offline — no ADR decision grants it an offline path', async () => {
  api.get = async () => { throw offline(); };
  const page = renderPage(React.createElement(TicketsPage));
  await settle();
  const button = page.all('button').find((b) => b.textContent.includes('New Ticket'));
  assert.ok(button);
  assert.equal(button.disabled, true);
  page.unmount();
});

// ── §6: offline product CRUD ─────────────────────────────────────────────────

test('§6: a product added blind is queued and shows on the grid as unsynced', async () => {
  api.request = async () => { throw offline(); };
  const { synced } = await createProductLocalFirst({ name: 'New SKU', unit: 'cs' }, { profileKey: 'josie' });
  assert.equal(synced, false);

  const queued = await queuedProductsFromOutbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].name, 'New SKU');
  assert.equal(queued[0]._unsynced, true);
  assert.match(String(queued[0].id), /^local-/, 'no server id yet, so it carries the local- shape');
});

test('§6: a blind stock correction is queued AND written onto the held catalogue copy', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  await updateProductLocalFirst(1, { current_stock: 40, reason: 'Physical count' }, {
    profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD], reason: 'Physical count',
  });

  const records = await listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].endpoint, '/products/1');
  assert.equal(records[0].payload.current_stock, 40);
  assert.equal(records[0].guard.checks[0].baseline, 20, 'the pre-edit value is remembered, which is what makes a conflict detectable');

  const [held] = await getCachedProducts();
  assert.equal(Number(held.current_stock), 40, 'the operator sees their own count, not the pre-edit one');
});

test('§6: a queued mutation records the profile that made it, per D14', async () => {
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };
  await updateProductLocalFirst(1, { base_wholesale_price: 950 }, {
    profileKey: 'luis', product: PRODUCT, guardFields: [PRICE_FIELD],
  });
  const [record] = await listRecords();
  assert.equal(record.profile_key, 'luis');
});

// ── §6: the conflict guard ───────────────────────────────────────────────────

test('§6: stock moving because of SALES is not a conflict — only a competing human count is', async () => {
  // The server's number moved from 20 to 14 because six cases were dispatched. That is
  // business happening, not a second person disagreeing about the shelf.
  const check = { field: STOCK_FIELD, baseline: 20, mine: 40 };
  const soldOnly = {
    current_stock: 14,
    audit_log: [auditEntry({ action_type: 'order_fulfillment', new_value: '14', created_at: '2026-08-29T10:00:00.000Z' })],
  };
  assert.equal(findCompetingEdit(soldOnly, check, '2026-08-29T09:00:00.000Z'), null);

  const counted = {
    current_stock: 14,
    audit_log: [auditEntry({ action_type: 'manual_adjustment', new_value: '14', created_at: '2026-08-29T10:00:00.000Z' })],
  };
  assert.ok(findCompetingEdit(counted, check, '2026-08-29T09:00:00.000Z'));
});

test('§6: a human edit made BEFORE this record was queued is not a conflict either', async () => {
  const check = { field: STOCK_FIELD, baseline: 20, mine: 40 };
  const product = {
    current_stock: 14,
    audit_log: [auditEntry({ new_value: '14', created_at: '2026-08-29T08:00:00.000Z' })],
  };
  assert.equal(findCompetingEdit(product, check, '2026-08-29T09:00:00.000Z'), null);
});

test('§6: a contested stock count is NOT sent — it becomes a question, and the record is dropped', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  // Queued blind at 09:00.
  await updateProductLocalFirst(1, { current_stock: 40, reason: 'Counted 40' }, {
    profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD], reason: 'Counted 40',
  });
  const [queuedRecord] = await listRecords();
  queuedRecord.created_at = '2026-08-29T09:00:00.000Z';
  await nativeStore.setJson(`v25.outbox.${String(queuedRecord.id).padStart(12, '0')}`, queuedRecord);

  // The line returns, and another tablet has since counted 35.
  const posted = [];
  api.request = async (path, opts) => { posted.push({ path, body: JSON.parse(opts.body) }); return { id: 1 }; };
  api.get = async () => ({
    ...PRODUCT, current_stock: 35,
    audit_log: [auditEntry({ new_value: '35', reason: 'Counted 35', created_at: '2026-08-29T10:00:00.000Z' })],
  });

  const result = await screenProductMutations();
  assert.equal(result.conflicts, 1);

  // Drain now that the line is genuinely up: §6 forbids silent last-write-wins, so the
  // contested count must not reach the server on this pass or any later one.
  await drainOutbox();
  assert.deepEqual(posted, [], 'nothing was sent — the count is a question, not a write');

  const [conflict] = await listConflicts();
  assert.equal(conflict.mine, 40);
  assert.equal(conflict.theirs, 35);
  assert.equal(conflict.baseline, 20);
  assert.equal(conflict.their_reason, 'Counted 35');
  assert.equal(conflict.profile_key, 'josie', 'the answer is credited to whoever made the edit, not whoever drains it');

  assert.equal((await listRecords()).length, 0, 'the record carried nothing but the contested field');
});

test('§6: a conflict on stock strips ONLY that field — the rest of the same edit still sends', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  await updateProductLocalFirst(1, {
    name: 'Red Horse 500ml (case)', current_stock: 40, reason: 'Counted 40',
  }, { profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD] });

  const [rec] = await listRecords();
  rec.created_at = '2026-08-29T09:00:00.000Z';
  await nativeStore.setJson(`v25.outbox.${String(rec.id).padStart(12, '0')}`, rec);

  api.get = async () => ({
    ...PRODUCT, current_stock: 35,
    audit_log: [auditEntry({ new_value: '35', created_at: '2026-08-29T10:00:00.000Z' })],
  });
  await screenProductMutations();

  const [survivor] = await listRecords();
  assert.ok(survivor, 'the record survives, because the rename is not contested');
  assert.equal(survivor.payload.current_stock, undefined, 'the contested count was lifted out');
  assert.equal(survivor.payload.name, 'Red Horse 500ml (case)');
  assert.equal((await listConflicts()).length, 1);
});

test('§6: one contested product in a batch reprice does not hold up the rest of the batch', async () => {
  await seedCatalogue([PRODUCT, { ...PRODUCT, id: 2, name: 'Pale Pilsen', base_wholesale_price: 800 }]);
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  await batchPriceLocalFirst(
    [{ id: 1, new_price: 950 }, { id: 2, new_price: 840 }],
    'August increase',
    { profileKey: 'josie', products: [PRODUCT, { ...PRODUCT, id: 2, name: 'Pale Pilsen', base_wholesale_price: 800 }] }
  );

  const [rec] = await listRecords();
  rec.created_at = '2026-08-29T09:00:00.000Z';
  await nativeStore.setJson(`v25.outbox.${String(rec.id).padStart(12, '0')}`, rec);

  api.get = async (path) => (path === '/products/1'
    ? { ...PRODUCT, base_wholesale_price: 990,
        audit_log: [auditEntry({ action_type: 'price_change', field_changed: 'base_wholesale_price',
                                 new_value: '990', created_at: '2026-08-29T10:00:00.000Z' })] }
    : { ...PRODUCT, id: 2, base_wholesale_price: 800, audit_log: [] });

  await screenProductMutations();

  const [survivor] = await listRecords();
  assert.deepEqual(survivor.payload.updates, [{ id: 2, new_price: 840 }]);
  const [conflict] = await listConflicts();
  assert.equal(conflict.product_id, 1);
  assert.equal(conflict.field, PRICE_FIELD);
});

test('§6: the guard changes nothing when the server cannot be reached', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };
  await updateProductLocalFirst(1, { current_stock: 40 }, {
    profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD],
  });

  const before = await listRecords();
  const res = await screenProductMutations();
  assert.equal(res.offline, true);
  assert.deepEqual(await listRecords(), before, 'an unscreened record is never sent, and never touched');
  assert.equal((await listConflicts()).length, 0);
});

test('§6: the same question is not stacked twice while it is still unanswered', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  for (const value of [40, 45]) {
    await updateProductLocalFirst(1, { current_stock: value }, {
      profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD],
    });
  }
  for (const rec of await listRecords()) {
    rec.created_at = '2026-08-29T09:00:00.000Z';
    await nativeStore.setJson(`v25.outbox.${String(rec.id).padStart(12, '0')}`, rec);
  }

  api.get = async () => ({
    ...PRODUCT, current_stock: 35,
    audit_log: [auditEntry({ new_value: '35', created_at: '2026-08-29T10:00:00.000Z' })],
  });
  await screenProductMutations();
  assert.equal((await listConflicts()).length, 1);
});

test('§6: an UNCHANGED stock or price is dropped from the payload, never sent and never asked about', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };

  // The full details form always sends every field. Only the name actually changed.
  await updateProductLocalFirst(1, {
    name: 'Red Horse 500ml (case)',
    current_stock: PRODUCT.current_stock,
    base_wholesale_price: PRODUCT.base_wholesale_price,
  }, { profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD, PRICE_FIELD] });

  const [record] = await listRecords();
  assert.equal(record.payload.current_stock, undefined,
    'an untouched count must not ride along and clobber another tablet\'s correction');
  assert.equal(record.payload.base_wholesale_price, undefined);
  assert.equal(record.payload.name, 'Red Horse 500ml (case)');
  assert.equal(record.guard, undefined, 'and there is nothing to adjudicate, so no guard');
});

test('§6: no drain path can send a guarded record that was not just screened', async () => {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };
  await updateProductLocalFirst(1, { current_stock: 40 }, {
    profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD],
  });

  // Age the screen stamp past its freshness window, then drain WITHOUT screening —
  // this is any of the several background drains that do not go through drainNow.
  const [rec] = await listRecords();
  rec.guard = { ...rec.guard, screened_at: Date.now() - 10 * 60 * 1000 };
  await nativeStore.setJson(`v25.outbox.${String(rec.id).padStart(12, '0')}`, rec);

  const sent = [];
  api.request = async (path) => { sent.push(path); return { id: 1 }; };
  await drainOutbox();

  assert.deepEqual(sent, [], 'the fail-safe holds even when the caller forgot to screen');
  assert.equal((await listRecords()).length, 1);

  // And it goes out the moment it HAS been screened against a server that agrees.
  api.get = async () => ({ ...PRODUCT, current_stock: 20, audit_log: [] });
  await screenProductMutations();
  await drainOutbox();
  assert.deepEqual(sent, ['/products/1']);
});

// ── §6: answering the question ───────────────────────────────────────────────

async function oneConflict() {
  await seedCatalogue();
  api.request = async () => { throw offline(); };
  api.get = async () => { throw offline(); };
  await updateProductLocalFirst(1, { current_stock: 40 }, {
    profileKey: 'josie', product: PRODUCT, guardFields: [STOCK_FIELD],
  });
  const [rec] = await listRecords();
  rec.created_at = '2026-08-29T09:00:00.000Z';
  await nativeStore.setJson(`v25.outbox.${String(rec.id).padStart(12, '0')}`, rec);
  api.get = async () => ({
    ...PRODUCT, current_stock: 35,
    audit_log: [auditEntry({ new_value: '35', created_at: '2026-08-29T10:00:00.000Z' })],
  });
  await screenProductMutations();
  const [conflict] = await listConflicts();
  return conflict;
}

test('§6: confirming a THIRD value (the count just made) is what gets written', async () => {
  const conflict = await oneConflict();
  const sent = [];
  api.request = async (path, opts) => { sent.push({ path, body: JSON.parse(opts.body) }); return { id: 1 }; };

  await resolveConflict(conflict.id, { value: 38, reason: 'Recounted the pallet' });

  assert.equal((await listConflicts()).length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.current_stock, 38);
  assert.equal(sent[0].body.reason, 'Recounted the pallet');
  const [held] = await getCachedProducts();
  assert.equal(Number(held.current_stock), 38);
});

test('§6: an answer is NOT re-screened — the operator is never asked the same thing twice', async () => {
  const conflict = await oneConflict();
  api.request = async () => ({ id: 1 });
  await resolveConflict(conflict.id, { value: 40 });
  assert.equal((await listRecords()).length, 0, 'it was sent, not held back for a second guard pass');
  assert.equal((await listConflicts()).length, 0);
});

test("§6: keeping the other tablet's value sends nothing and closes the question", async () => {
  const conflict = await oneConflict();
  const sent = [];
  api.request = async (path, opts) => { sent.push(path); return { id: 1 }; };

  await keepServerValue(conflict.id);

  assert.equal(sent.length, 0);
  assert.equal((await listConflicts()).length, 0);
  const [held] = await getCachedProducts();
  assert.equal(Number(held.current_stock), 35, 'the local copy falls in line with what stands on the server');
});

test('§6: confirming the value the server already holds sends nothing', async () => {
  const conflict = await oneConflict();
  const sent = [];
  api.request = async (path) => { sent.push(path); return { id: 1 }; };
  await resolveConflict(conflict.id, { value: 35 });
  assert.equal(sent.length, 0);
  assert.equal((await listConflicts()).length, 0);
});

test('§6: an unanswered conflict stays put — nothing resolves it by default', async () => {
  const conflict = await oneConflict();
  api.request = async () => ({ id: 1 });
  api.get = async () => ({ ...PRODUCT, current_stock: 35, audit_log: [] });
  await screenProductMutations();
  const open = await listConflicts();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, conflict.id);
});

// ── §8: offline incoming deliveries ──────────────────────────────────────────

test('§8: a delivery reference is <station>-DEL-<seq>, off its own counter', async () => {
  await registerStation(3);
  const first = await issueDeliveryRef();
  const second = await issueDeliveryRef();
  assert.equal(first.delivery_ref, '3-DEL-00001');
  assert.equal(second.delivery_ref, '3-DEL-00002');
  assert.deepEqual(parseDeliveryRef('3-DEL-00002'), { station: 3, device: null, sequence: 2 });
  assert.equal(parseDeliveryRef('3-00002'), null, 'a receipt number is never read as a delivery reference');
  // ADR 0017 #14 — the same per-person device letter, and the same both-shapes rule.
  assert.equal(formatDeliveryRef(3, 2, 'A'), '3A-DEL-00002');
  assert.deepEqual(parseDeliveryRef('3A-DEL-00002'), { station: 3, device: 'A', sequence: 2 });
  assert.equal(parseDeliveryRef('3A-00002'), null);
  assert.equal(formatDeliveryRef(1, 7), '1-DEL-00007');
});

test('§8: a delivery logged blind is queued with its reference and bumps the held stock', async () => {
  await registerStation(1);
  await seedCatalogue();
  api.request = async () => { throw offline(); };

  const { synced, deliveryRef } = await logDeliveryLocalFirst({
    supplier_name: 'San Miguel Brewery',
    received_at: '2026-08-29',
    items: [{ product_id: 1, quantity_received: 10, unit_cost: null, notes: null }],
  }, { profileKey: 'josie' });

  assert.equal(synced, false);
  assert.equal(deliveryRef, '1-DEL-00001');

  const [record] = await listRecords();
  assert.equal(record.endpoint, '/incoming');
  assert.equal(record.payload.delivery_ref, '1-DEL-00001');
  assert.equal(record.profile_key, 'josie');

  const [held] = await getCachedProducts();
  assert.equal(Number(held.current_stock), 30, 'the counter stops showing the pre-delivery count');
});

test('§8: a queued delivery is visible on the list, and drops out once its server copy shows up', async () => {
  await registerStation(1);
  api.request = async () => { throw offline(); };
  await logDeliveryLocalFirst({
    supplier_name: 'Coca-Cola', received_at: '2026-08-29',
    items: [{ product_id: 1, quantity_received: 4 }],
  }, { profileKey: 'josie' });

  const local = await queuedDeliveriesFromOutbox();
  assert.equal(local.length, 1);
  assert.equal(local[0]._unsynced, true);
  assert.equal(local[0].item_count, 1);

  assert.equal(mergeDeliveries([], local).length, 1);

  const serverCopy = [{ id: 91, delivery_ref: '1-DEL-00001', supplier_name: 'Coca-Cola',
                        received_at: '2026-08-29T00:00:00.000Z', item_count: 1 }];
  const merged = mergeDeliveries(serverCopy, local);
  assert.equal(merged.length, 1, 'deduped by reference — never shown twice');
  assert.equal(merged[0].id, 91);
});

test('§8: a delivery logged with the line up takes the same path and reports as synced', async () => {
  await registerStation(2);
  await seedCatalogue();
  api.request = async () => ({ id: 55 });

  const { synced, deliveryRef } = await logDeliveryLocalFirst({
    supplier_name: 'San Miguel Brewery', received_at: '2026-08-29',
    items: [{ product_id: 1, quantity_received: 2 }],
  }, { profileKey: 'josie' });

  assert.equal(synced, true);
  assert.equal(deliveryRef, '2-DEL-00001');
  assert.equal((await listRecords()).length, 0);
});

// ── §7: customer profile edits ───────────────────────────────────────────────

test('§7: a blind customer profile edit is queued and written onto the held directory', async () => {
  await applyCatalogueDelta('customers', [
    { id: 5, name: 'Aling Nena', customer_type: 'regular', phone: '0900', address: 'Old address', is_active: true },
  ]);
  api.request = async () => { throw offline(); };

  const { synced } = await updateCustomerLocalFirst(5, {
    name: 'Aling Nena', customer_type: 'regular', phone: '0900',
    address: 'New address, Antipolo', notes: null, is_active: true,
  }, { profileKey: 'josie' });

  assert.equal(synced, false);
  const [record] = await listRecords();
  assert.equal(record.method, 'PATCH');
  assert.equal(record.endpoint, '/customers/5');
  assert.equal(record.profile_key, 'josie');

  const [held] = await getCachedCustomers();
  assert.equal(held.address, 'New address, Antipolo',
    'the new address is what the directory and the order picker show, not the pre-edit one');
});

// ── Cross-cutting ────────────────────────────────────────────────────────────

test('an unrelated queued record is untouched by the product guard', async () => {
  await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'Aling Nena' }, profileKey: 'josie',
  });
  api.get = async () => { throw new Error('the guard must not fetch anything for an unguarded record'); };
  const res = await screenProductMutations();
  assert.equal(res.checked, 0);
  assert.equal((await listRecords()).length, 1);
});
