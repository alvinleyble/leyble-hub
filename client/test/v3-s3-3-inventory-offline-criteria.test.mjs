// V3.0 Slice 3.3 — review fixes against the captain's acceptance criteria doc
// (docs/offline-accessibility-acceptance-criteria.md, section 7 + the 8.5 rule).
//
// The first cut of this slice satisfied ADR 0015 §6's prose ("full offline CRUD") and
// missed the narrower rules the criteria doc spells out on top of it:
//   * 7.3 / 7.4 — bottles-per-case and "requires bottle return" are NOT a blind
//     device's to decide. units_per_case is baked into order_items.line_total (a
//     GENERATED column) and the bottle-return flag decides whether the deposit ledger
//     applies at all, so neither has a second honest value to reconcile the way a
//     stock count does.
//   * the same rule for the active flag, on products (captain, 2026-08-29) and on
//     customers (8.5) — the customer one only became reachable in this slice, when
//     profile edits started queueing.
//   * 7.5 — an offline-added product is real immediately, and an offline EDIT to an
//     existing product needs the same "Waiting to sync" affordance. The edit case was
//     invisible: the held copy already showed the operator's new number.
//
// Disabled-with-a-message is the UX contract; the payload assertions below are what
// make it true on the wire, so a stale form value cannot ride along and reverse
// another tablet's change on a field with no reconciliation path.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearOutbox, listRecords } from '../src/offline/outbox.js';
import { __clearConflicts } from '../src/offline/reconcile.js';
import {
  createProductLocalFirst, updateProductLocalFirst, batchPriceLocalFirst,
  pendingProductEditIds,
} from '../src/offline/productMutations.js';
import { applyCatalogueDelta } from '../src/offline/catalogue.js';

const ProductDetailPanel = (await import('../src/pages/inventory/ProductDetailPanel.jsx')).default;
const ProductFormModal   = (await import('../src/pages/inventory/ProductFormModal.jsx')).default;
const CustomerDetailPanel = (await import('../src/pages/customers/CustomerDetailPanel.jsx')).default;

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const offline = () => { throw new Error('Failed to fetch'); };

const PRODUCT = {
  id: 7, name: 'Red Horse 500ml', sku: 'RH-5', category: 'Beer', unit: 'cs',
  base_wholesale_price: 900, deposit_fee: 5, current_stock: 20, units_per_case: 24,
  requires_bottle_return: true, is_active: true,
};

const CUSTOMER = {
  id: 4, name: 'Tindahan ni Juan', customer_type: 'regular', phone: '09998887777',
  address: 'Marikina City', notes: '', is_active: true, orders: [],
};

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  await __clearConflicts();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

const withToast = (el) => React.createElement(ToastProvider, null, el);

// The panel falls back to its cached copy when the read fails, which is exactly the
// state every criteria-7 rule below is about.
async function renderPanelOffline() {
  await applyCatalogueDelta('products', [PRODUCT]);
  api.get = async () => offline();
  api.request = async () => offline();
  const r = render(withToast(React.createElement(ProductDetailPanel, {
    productId: PRODUCT.id, cachedProduct: PRODUCT,
    onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  return r;
}

async function renderPanelOnline() {
  api.get = async (path) =>
    (path === `/products/${PRODUCT.id}` ? { ...PRODUCT, audit_log: [] } : []);
  const r = render(withToast(React.createElement(ProductDetailPanel, {
    productId: PRODUCT.id, onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  return r;
}

const unitsPerCaseInput = (r) => r.container.querySelector('input[step="1"]');
const bottleReturnInput = (r) => r.container.querySelector('#requires_bottle_return');
const activeInput       = (r) => r.container.querySelector('#is_active');
const depositInput      = (r) => r.all('input[step="0.01"]')[1];

// ── 7.3 / 7.4 and the product active flag ────────────────────────────────────

test('7.3 / 7.4: bottles-per-case and bottle-return are locked while the panel is offline', async () => {
  const r = await renderPanelOffline();

  assert.equal(unitsPerCaseInput(r).disabled, true, 'Bottles per Case (7.4)');
  assert.equal(bottleReturnInput(r).disabled, true, 'Requires bottle return (7.3)');
  assert.equal(depositInput(r).disabled, true, 'the deposit follows the flag it belongs to');
  assert.equal(activeInput(r).disabled, true, 'active flag — same rule as 8.5 / 9.2');

  // Disabled with a REASON on screen, never a silently inert control.
  assert.match(r.text(), /Bottle return and its deposit need a connection/);
  assert.match(r.text(), /Hiding or restoring a product needs a connection/);

  r.unmount();
});

test('7.3 / 7.4: the same controls are freely editable with the line up', async () => {
  const r = await renderPanelOnline();

  assert.equal(unitsPerCaseInput(r).disabled, false);
  assert.equal(bottleReturnInput(r).disabled, false);
  assert.equal(activeInput(r).disabled, false);
  assert.doesNotMatch(r.text(), /needs a connection/i);

  r.unmount();
});

test('7.3 / 7.4: a blind save carries neither locked field, so it cannot reverse another tablet', async () => {
  const r = await renderPanelOffline();

  const save = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  r.click(save);
  await settle();

  const [record] = (await listRecords()).filter((x) => x.entity_type === 'product_update');
  assert.ok(record, 'the edit itself still queues — only the locked fields are withheld');
  for (const field of ['units_per_case', 'requires_bottle_return', 'deposit_fee', 'is_active']) {
    assert.equal(record.payload[field], undefined, `${field} must not be on the wire`);
  }
  // …while the rest of the form is exactly as before.
  assert.equal(record.payload.name, PRODUCT.name);
  assert.equal(record.payload.sku, PRODUCT.sku);

  r.unmount();
});

test('7.5 / 7.3 / 7.4: Add Product still works blind, with the two undecidable fields locked', async () => {
  api.request = async () => offline();
  const r = render(withToast(React.createElement(ProductFormModal, {
    offline: true, onClose: () => {}, onSaved: () => {},
  })));
  await settle();

  assert.equal(r.container.querySelector('input[step="1"]').disabled, true, '7.4');
  assert.equal(r.all('input[type="checkbox"]')[0].disabled, true, '7.3');
  assert.match(r.text(), /Bottle return and bottles-per-case need a connection/);
  // 7.5 — adding is NOT blocked; the form still saves.
  const save = r.all('button').find((b) => b.textContent.includes('Save Product'));
  assert.equal(save.disabled, false);

  r.unmount();
});

// ── 7.5: the sync-status affordance, both directions ─────────────────────────

test('7.5: an existing product carrying a queued edit is reported as waiting to sync', async () => {
  api.get = async () => offline();
  api.request = async () => offline();
  await applyCatalogueDelta('products', [PRODUCT]);

  assert.equal((await pendingProductEditIds()).size, 0, 'nothing pending to begin with');

  await updateProductLocalFirst(PRODUCT.id, { current_stock: 40 }, {
    profileKey: 'josie', product: PRODUCT, guardFields: ['current_stock'],
  });

  const pending = await pendingProductEditIds();
  assert.ok(pending.has(String(PRODUCT.id)), 'the row the operator just edited says so');
});

test('7.5: every product in a queued batch reprice is reported, not just the first', async () => {
  api.get = async () => offline();
  api.request = async () => offline();

  await batchPriceLocalFirst(
    [{ id: 7, new_price: 950 }, { id: 8, new_price: 700 }],
    'Supplier increase',
    { profileKey: 'josie', products: [PRODUCT, { ...PRODUCT, id: 8, name: 'Pale Pilsen' }] },
  );

  const pending = await pendingProductEditIds();
  assert.deepEqual([...pending].sort(), ['7', '8']);
});

test('7.5: a queued CREATE is not reported as a pending edit — it has no row to badge', async () => {
  api.request = async () => offline();
  await createProductLocalFirst({ name: 'New SKU', unit: 'cs', base_wholesale_price: 100 }, {
    profileKey: 'josie',
  });

  assert.equal((await pendingProductEditIds()).size, 0);
  assert.equal((await listRecords()).filter((r) => r.entity_type === 'product').length, 1);
});

test('7.5: the badge clears itself once the edit drains', async () => {
  api.get = async () => offline();
  api.request = async () => offline();
  await applyCatalogueDelta('products', [PRODUCT]);

  await updateProductLocalFirst(PRODUCT.id, { current_stock: 40 }, {
    profileKey: 'josie', product: PRODUCT, guardFields: ['current_stock'],
  });
  assert.equal((await pendingProductEditIds()).size, 1);

  // The line comes back: the guard screens clean and the record goes.
  api.get = async () => ({ ...PRODUCT, audit_log: [] });
  api.request = async () => ({ ...PRODUCT, current_stock: 40 });
  const { drainOutbox } = await import('../src/offline/outbox.js');
  const { screenProductMutations } = await import('../src/offline/productMutations.js');
  await screenProductMutations();
  await drainOutbox();

  assert.equal((await pendingProductEditIds()).size, 0, 'nothing is still waiting');
});

test('7.5: the panel says an edit is waiting to sync, rather than just showing the new number', async () => {
  const r = await renderPanelOffline();
  assert.doesNotMatch(r.text(), /Waiting to sync/);

  const save = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  r.click(save);
  await settle();

  assert.match(r.text(), /Waiting to sync/);
  r.unmount();
});

// ── 8.5: the same rule on customers, newly reachable now that edits queue ─────

test('8.5: the customer active flag is locked offline while the rest of the form still saves', async () => {
  api.get = async () => offline();
  api.request = async () => offline();
  await applyCatalogueDelta('customers', [CUSTOMER]);

  const r = render(withToast(React.createElement(CustomerDetailPanel, {
    customerId: CUSTOMER.id, onClose: () => {}, onSaved: () => {},
  })));
  await settle();

  const active = r.container.querySelector('#cust_active');
  assert.ok(active, 'the toggle is still shown, not hidden');
  assert.equal(active.disabled, true);
  assert.match(r.text(), /Deactivating or restoring a customer needs a connection/);

  const save = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.equal(save.disabled, false, '8.4 — the rest of the form still saves blind');
  r.click(save);
  await settle();

  const [record] = (await listRecords()).filter((x) => x.entity_type === 'customer_update');
  assert.ok(record);
  assert.equal(record.payload.is_active, undefined, 'is_active must not be on the wire');
  assert.equal(record.payload.name, CUSTOMER.name);

  r.unmount();
});
