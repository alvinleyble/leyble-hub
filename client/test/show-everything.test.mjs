// Settings' "Show everything" switch and the trimmed app it controls.
//
// Off (the default on every device) the app is what the owners use: Outgoing up to
// pending and printed, Customers, Inventory as a product and price list, Dashboard,
// Settings. On it is the whole app as it was before the trim. The switch lives in
// native storage, so it is read blind and survives a restart; nothing about it reaches
// the server.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { AuthProvider, __setIsNativeForTest } from '../src/context/AuthContext.jsx';
import { nativeStore, __resetMemoryBackend, __setBackend } from '../src/offline/nativeStore.js';
import { SHOW_EVERYTHING_KEY } from '../src/offline/keys.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import {
  loadShowEverything, setShowEverything, getShowEverything, __resetShowEverythingForTest,
} from '../src/config/showEverything.js';
import { productListHtml } from '../src/pages/shared/listPrintTemplate.js';
import { productListEscPos } from '../src/pages/shared/listEscPos.js';

const TopTabBar = (await import('../src/components/layout/TopTabBar.jsx')).default;
const MenuDrawer = (await import('../src/components/layout/MenuDrawer.jsx')).default;
const EverythingRoute = (await import('../src/components/layout/EverythingRoute.jsx')).default;
const SettingsList = (await import('../src/pages/settings/SettingsList.jsx')).default;
const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const InventoryPage = (await import('../src/pages/inventory/InventoryPage.jsx')).default;
const ProductDetailPanel = (await import('../src/pages/inventory/ProductDetailPanel.jsx')).default;
const ProductFormModal = (await import('../src/pages/inventory/ProductFormModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

const h = React.createElement;

let saved;
const mounted = [];

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del };
  __setIsNativeForTest(false);
  __resetMemoryBackend();
  __resetShowEverythingForTest();
  await __clearReceipts();
  await __clearOutbox();
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  while (mounted.length) mounted.pop()();
  Object.assign(api, saved);
  __resetShowEverythingForTest();
});

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// Mounts `element` at `path` inside a real router, with a probe that reports where any
// redirect landed.
function Where() {
  const { pathname } = useLocation();
  return h('output', { 'data-testid': 'where' }, pathname);
}
function mountAt(path, element, routes = null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(MemoryRouter, { initialEntries: [path] },
      h(ToastProvider, null,
        h(Where),
        routes || element)));
  });
  const view = {
    container,
    text: () => container.textContent,
    where: () => container.querySelector('[data-testid="where"]').textContent,
    buttons: () => [...container.querySelectorAll('button')].map((b) => b.textContent.trim()),
    button: (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text)),
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    unmount: () => act(() => root.unmount()),
  };
  mounted.push(view.unmount);
  return view;
}

// ── The switch itself: default off, kept on the device ───────────────────────

test('a device that has never touched the switch reads it as off', async () => {
  assert.equal(await loadShowEverything(), false);
  assert.equal(getShowEverything(), false);
  assert.equal(await nativeStore.getString(SHOW_EVERYTHING_KEY), null, 'reading writes nothing');
});

test('the switch is kept in native storage and survives an app restart', async () => {
  await setShowEverything(true);
  assert.equal(await nativeStore.getString(SHOW_EVERYTHING_KEY), 'on');

  __resetShowEverythingForTest();            // the app starts again: memory is gone…
  assert.equal(getShowEverything(), false);
  assert.equal(await loadShowEverything(), true, '…and the stored value brings it back on');

  await setShowEverything(false);
  assert.equal(await nativeStore.getString(SHOW_EVERYTHING_KEY), 'off');
  __resetShowEverythingForTest();
  assert.equal(await loadShowEverything(), false);
});

test('storage that cannot be read leaves the switch off', async () => {
  __setBackend({
    get: async () => { throw new Error('native store unavailable'); },
    set: async () => {}, remove: async () => {}, keys: async () => [],
  });
  assert.equal(await loadShowEverything(), false);
});

test('the switch never goes to the server', async () => {
  const calls = [];
  api.get = async (p) => { calls.push(['get', p]); return []; };
  api.post = async (p) => { calls.push(['post', p]); return {}; };
  api.patch = async (p) => { calls.push(['patch', p]); return {}; };
  await setShowEverything(true);
  await setShowEverything(false);
  assert.deepEqual(calls, []);
});

// ── Navigation ───────────────────────────────────────────────────────────────

const tabLabels = (view) => [...view.container.querySelectorAll('nav[aria-label="Main navigation"] a')]
  .map((a) => a.textContent.trim());
const menuRows = (view) => [...view.container.querySelectorAll('[data-testid="nav-menu"] nav a, [data-testid="nav-menu"] nav button')]
  .map((el) => el.textContent.trim());

test('off: four tabs, and the menu holds Settings and Log out only', async () => {
  api.get = async () => [];
  const view = mountAt('/dashboard', h(React.Fragment, null,
    h(TopTabBar, { onOpenMenu: () => {} }),
    h(AuthProvider, null, h(MenuDrawer, { open: true, onClose: () => {} }))));
  await settle();
  assert.deepEqual(tabLabels(view), ['Dashboard', 'Outgoing', 'Inventory', 'Customers']);
  assert.deepEqual(menuRows(view), ['Settings', 'Log out']);
});

test('on: the six tabs and the full menu, exactly as before', async () => {
  await setShowEverything(true);
  api.get = async () => [];
  const view = mountAt('/dashboard', h(React.Fragment, null,
    h(TopTabBar, { onOpenMenu: () => {} }),
    h(AuthProvider, null, h(MenuDrawer, { open: true, onClose: () => {} }))));
  await settle();
  assert.deepEqual(tabLabels(view), ['Dashboard', 'Outgoing', 'Incoming', 'Inventory', 'Customers', 'Personnel']);
  assert.deepEqual(menuRows(view), ['Tickets', 'Audit Log', 'Settings', 'Log out']);
});

test('Settings shows the switch, off, and flipping it changes the app at once', async () => {
  api.get = async () => [];
  const view = mountAt('/settings', h(React.Fragment, null,
    h(TopTabBar, { onOpenMenu: () => {} }),
    h(SettingsList, { userName: 'Josie', receiptSummary: null, native: false })));
  await settle();

  const toggle = view.container.querySelector('[data-testid="settings-show-everything"]');
  assert.ok(toggle, 'the switch is on the Settings screen');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.match(toggle.textContent, /Show everything/);
  assert.equal(view.container.querySelector('[data-testid="settings-show-everything-state"]').textContent, 'Off',
    'the state is said in words, not by colour alone');
  assert.equal(tabLabels(view).length, 4);

  view.click(toggle);
  await settle();
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(view.container.querySelector('[data-testid="settings-show-everything-state"]').textContent, 'On');
  assert.equal(tabLabels(view).length, 6, 'no reinstall, no reload: the tabs come back straight away');
  assert.equal(await nativeStore.getString(SHOW_EVERYTHING_KEY), 'on');

  view.click(toggle);
  await settle();
  assert.equal(tabLabels(view).length, 4);
  assert.equal(await nativeStore.getString(SHOW_EVERYTHING_KEY), 'off');
});

// ── Hidden screens cannot be reached by a typed route ────────────────────────

function hiddenRoutes() {
  return h(Routes, null,
    h(Route, { path: '/orders', element: h('p', null, 'Outgoing screen') }),
    ...['incoming', 'personnel/*', 'tickets', 'audit'].map((p) => h(Route, {
      key: p, path: `/${p}`, element: h(EverythingRoute, null, h('p', null, `Hidden ${p} screen`)),
    })));
}

for (const path of ['/incoming', '/personnel', '/personnel/12', '/tickets', '/audit']) {
  test(`off: typing ${path} lands on Outgoing`, async () => {
    const view = mountAt(path, null, hiddenRoutes());
    await settle();
    assert.equal(view.where(), '/orders');
    assert.match(view.text(), /Outgoing screen/);
    assert.doesNotMatch(view.text(), /Hidden/);
  });
}

test('on: the hidden screens open as before', async () => {
  // A cold start with the switch stored on: the guard waits for the read rather than
  // bouncing the operator to Outgoing first.
  await nativeStore.setString(SHOW_EVERYTHING_KEY, 'on');
  __resetShowEverythingForTest();
  const view = mountAt('/tickets', null, hiddenRoutes());
  await settle();
  assert.equal(view.where(), '/tickets');
  assert.match(view.text(), /Hidden tickets screen/);
});

// ── Outgoing list ────────────────────────────────────────────────────────────

const listOrder = (id, over = {}) => ({
  id, customer_id: id, status: 'pending', order_type: 'delivery', customer_name: `Customer ${id}`,
  total_amount: 500, adjustment: 0, created_at: '2026-11-10T02:00:00.000Z',
  pending_receipt_printed_at: null, delivered_receipt_printed_at: null,
  receipt_number: `1A-0000${id}`, ...over,
});

function stubOrdersList(orders) {
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      return { orders, pagination: { page: 1, limit: 50, total: orders.length, totalPages: 1 } };
    }
    return [];
  };
}

const chips = (view) => [...view.container.querySelectorAll('[data-testid^="orders-tab-"]')]
  .map((el) => el.getAttribute('data-testid').replace('orders-tab-', ''));

test('off: Outgoing shows All, Drafts, Pending and Cancelled, keeps Possible Duplicates, and lists later-stage orders with their status', async () => {
  stubOrdersList([
    listOrder(1),
    listOrder(2, { status: 'in_transit' }),
    listOrder(3, { status: 'completed', delivered_receipt_printed_at: '2026-11-10T03:00:00.000Z' }),
    listOrder(4, { status: 'done' }),
  ]);
  const view = mountAt('/orders', h(OrdersPage));
  await settle();

  assert.deepEqual(chips(view), ['all', 'draft', 'pending', 'cancelled']);
  assert.ok(view.button('Possible Duplicates'), 'the duplicate flag stays');
  for (const status of ['In Transit', 'Delivered', 'Closed']) {
    assert.match(view.text(), new RegExp(status), `a ${status} order still shows under All, with its status`);
  }
  assert.equal(view.container.querySelectorAll('[data-testid="orders-row"], tr[class*="cursor-pointer"]').length > 0, true);
});

test('off: Pending offers no selection, so no Dispatch, Mark Picked Up or Review Selected', async () => {
  stubOrdersList([listOrder(1), listOrder(2, { order_type: 'pickup' })]);
  const view = mountAt('/orders', h(OrdersPage));
  await settle();
  view.click(view.container.querySelector('[data-testid="orders-tab-pending"]'));
  await settle();
  assert.equal(view.container.querySelector('[aria-label="Select all orders"]'), null);
  assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0);
  for (const label of ['Dispatch Selected', 'Mark Picked Up', 'Review Selected']) {
    assert.equal(view.button(label), undefined, `${label} is not offered`);
  }
});

test('off: Drafts keeps its selection and Discard Selected', async () => {
  const draft = listOrder(9, { status: 'draft', receipt_number: null });
  api.get = async (path) => {
    if (path === '/orders?status=draft') return [draft];
    if (path.startsWith('/orders')) return { orders: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } };
    return [];
  };
  const view = mountAt('/orders', h(OrdersPage));
  await settle();
  view.click(view.container.querySelector('[data-testid="orders-tab-draft"]'));
  await settle();
  assert.ok(view.container.querySelectorAll('input[type="checkbox"]').length > 0, 'drafts can still be selected');
});

test('on: all seven status chips and the Pending bulk actions come back', async () => {
  await setShowEverything(true);
  stubOrdersList([listOrder(1)]);
  const view = mountAt('/orders', h(OrdersPage));
  await settle();
  assert.deepEqual(chips(view), ['all', 'draft', 'pending', 'in_transit', 'completed', 'done', 'cancelled']);
  view.click(view.container.querySelector('[data-testid="orders-tab-pending"]'));
  await settle();
  assert.ok(view.container.querySelector('[aria-label="Select all orders"]'));
});

// ── Order detail ─────────────────────────────────────────────────────────────

const detailOrder = (over = {}) => ({
  id: 42, receipt_number: '1A-00042', revision: '5', status: 'pending', order_type: 'delivery',
  customer_id: 7, customer_name: 'Aling Nena', created_at: '2026-11-10T01:00:00.000Z',
  adjustment: 0, adjustment_reason: null, total_amount: 300, notes: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', category: 'Softdrinks',
    unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0,
    units_per_case: 24, bottles_returned: 0, requires_bottle_return: false,
  }],
  personnel: [],
  ...over,
});

function mountDetail(order) {
  api.get = async (path) => (path === '/orders/42' ? order : []);
  return mountAt('/orders/42', null,
    h(Routes, null, h(Route, { path: '/orders/:id', element: h(OrderDetailPage) })));
}

const STAGE_BUTTONS = [
  'Start Dispatch', 'Mark as Picked Up', 'Mark as Delivered', 'Back to Pending',
  'Back to In Transit', 'Reopen Order', 'Close Order',
];

const cases = [
  ['pending delivery', {}, ['Start Dispatch']],
  ['pending pickup', { order_type: 'pickup' }, ['Mark as Picked Up']],
  ['in transit', { status: 'in_transit' }, ['Mark as Delivered', 'Back to Pending']],
  ['delivered', { status: 'completed' }, ['Back to In Transit', 'Close Order']],
  ['picked up', { status: 'completed', order_type: 'pickup' }, ['Back to Pending', 'Close Order']],
  ['closed', { status: 'done' }, ['Reopen Order']],
];

for (const [name, over, stageButtons] of cases) {
  test(`off: a ${name} order shows no step past pending`, async () => {
    const view = mountDetail(detailOrder(over));
    await settle();
    const buttons = view.buttons();
    for (const label of STAGE_BUTTONS) {
      assert.ok(!buttons.some((b) => b.includes(label)), `${label} is hidden`);
    }
    assert.ok(buttons.some((b) => b.includes('Edit Order')), 'Edit stays');
    if (over.status !== 'done') assert.ok(buttons.some((b) => b.includes('Cancel Order')), 'Cancel stays');
    if (over.status !== 'in_transit') assert.ok(buttons.some((b) => b.includes('Print Receipt')), 'Print stays');
  });

  test(`on: a ${name} order shows its stage buttons as before`, async () => {
    await setShowEverything(true);
    const view = mountDetail(detailOrder(over));
    await settle();
    const buttons = view.buttons();
    for (const label of stageButtons) {
      assert.ok(buttons.some((b) => b.includes(label)), `${label} is shown`);
    }
  });
}

test('off: the review queue never offers Dispatch even if one is opened', async () => {
  api.get = async (path) => (path === '/orders/42' ? detailOrder() : []);
  const view = mountAt('/orders', h(ReviewQueueModal, { orderIds: [42], mode: 'pending', onClose: () => {} }));
  await settle();
  assert.ok(!view.buttons().some((b) => b.includes('Dispatch')));
  assert.ok(view.buttons().some((b) => b.includes('Print Receipt')), 'printing stays');
});

// ── Printing tags the order without asking ───────────────────────────────────

function stubPrintWindow({ blocked = false } = {}) {
  const original = window.open;
  const handlers = {};
  window.open = () => (blocked ? null : {
    closed: false,
    document: { write() {}, close() {} },
    focus() {}, print() {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
  });
  return { afterPrint: () => handlers.afterprint?.(), restore: () => { window.open = original; } };
}

test('a finished print tags the order as printed with no question', async () => {
  const order = detailOrder();
  const posts = [];
  api.post = async (path, body) => {
    posts.push({ path, body });
    return { ...order, revision: '6', pending_receipt_printed_at: '2026-11-10T02:00:00.000Z' };
  };
  const popup = stubPrintWindow();
  try {
    const view = mountDetail(order);
    await settle();
    view.click(view.button('Print Receipt'));
    await settle();
    // "Print twice for your copy?" is untouched.
    assert.match(view.text(), /Print twice for your copy\?/);
    view.click(view.button('No'));
    await settle();
    act(() => popup.afterPrint());
    await settle();
    assert.doesNotMatch(view.text(), /Tag receipt as printed/);
    assert.deepEqual(posts.map((p) => [p.path, p.body.phase]), [['/orders/42/receipt-printed', 'pending']]);
  } finally {
    popup.restore();
  }
});

test('a print that never happens leaves the order untagged', async () => {
  const posts = [];
  api.post = async (path) => { posts.push(path); return {}; };
  const popup = stubPrintWindow({ blocked: true });
  try {
    const view = mountDetail(detailOrder({ status: 'completed' }));
    await settle();
    view.click(view.button('Print Receipt'));
    await settle();
    assert.deepEqual(posts, []);
    assert.doesNotMatch(view.text(), /Tag receipt as printed/);
  } finally {
    popup.restore();
  }
});

// ── Inventory: a product and price list ──────────────────────────────────────

const PRODUCTS = [
  { id: 1, name: 'Coke 1.5L', sku: 'C-1.5', category: 'Soda', unit: 'case', current_stock: 3,
    base_wholesale_price: 600, deposit_fee: 0, units_per_case: 12, is_active: true },
  { id: 2, name: 'Red Horse', sku: 'RH-1', category: 'Beer', unit: 'case', current_stock: 0,
    base_wholesale_price: 900, deposit_fee: 5, units_per_case: 12, requires_bottle_return: true, is_active: true },
];

test('off: Inventory shows no stock counts, stock filter or low/out-of-stock marks', async () => {
  api.get = async () => PRODUCTS;
  const view = mountAt('/inventory', h(InventoryPage));
  await settle();
  assert.match(view.text(), /Coke 1\.5L/);
  assert.match(view.text(), /₱600\.00/, 'prices stay');
  assert.ok(view.button('Beer'), 'categories stay');
  assert.doesNotMatch(view.text(), /In stock:/);
  assert.doesNotMatch(view.text(), /Low stock|Out of stock|All stock/);
  const headers = [...view.container.querySelectorAll('th')].map((th) => th.textContent.trim());
  assert.ok(!headers.includes('Stock'), 'no Stock column');
  assert.ok(headers.includes('Price / Case') && headers.includes('Deposit / Bottle'));
});

test('on: Inventory shows stock exactly as before', async () => {
  await setShowEverything(true);
  api.get = async () => PRODUCTS;
  const view = mountAt('/inventory', h(InventoryPage));
  await settle();
  assert.match(view.text(), /In stock:/);
  assert.match(view.text(), /All stock/);
  assert.match(view.text(), /Out of stock/);
  const headers = [...view.container.querySelectorAll('th')].map((th) => th.textContent.trim());
  assert.ok(headers.includes('Stock'));
});

const productDetail = {
  ...PRODUCTS[0],
  audit_log: [
    { id: 1, action_type: 'manual_adjustment', field_changed: 'current_stock', previous_value: '5', new_value: '3', delta: -2, created_at: '2026-11-09T01:00:00.000Z', performed_by_name: 'Josie' },
    { id: 2, action_type: 'price_change', field_changed: 'base_wholesale_price', previous_value: '550', new_value: '600', delta: null, created_at: '2026-11-08T01:00:00.000Z', performed_by_name: 'Luis' },
  ],
};

test('off: a product opens with no stock summary, no Adjust Stock, and no stock entries in its log', async () => {
  api.get = async () => productDetail;
  const view = mountAt('/inventory', h(ProductDetailPanel, {
    productId: 1, onClose: () => {}, onSaved: () => {}, stockShown: false,
  }));
  await settle();
  assert.match(view.text(), /Wholesale Price/);
  assert.doesNotMatch(view.text(), /Current Stock|Adjust Stock/);
  assert.match(view.text(), /base wholesale price/i, 'price history stays');
  assert.doesNotMatch(view.text(), /Stock: 5/, 'stock movements are left out');
  view.click(view.button('Edit details'));
  await settle();
  assert.doesNotMatch(view.text(), /Current Stock/, 'the edit form has no stock field');
});

test('on: a product opens with its stock and Adjust Stock as before', async () => {
  api.get = async () => productDetail;
  const view = mountAt('/inventory', h(ProductDetailPanel, {
    productId: 1, onClose: () => {}, onSaved: () => {}, stockShown: true,
  }));
  await settle();
  assert.match(view.text(), /Current Stock/);
  assert.ok(view.button('Adjust Stock'));
  assert.match(view.text(), /Stock: 5/);
});

test('off: adding a product asks for no initial stock', async () => {
  const off = mountAt('/inventory', h(ProductFormModal, { onClose: () => {}, onSaved: () => {}, stockShown: false }));
  await settle();
  assert.doesNotMatch(off.text(), /Initial Stock/);
  assert.match(off.text(), /Wholesale Price/);
  off.unmount();
  mounted.pop();
  const on = mountAt('/inventory', h(ProductFormModal, { onClose: () => {}, onSaved: () => {} }));
  await settle();
  assert.match(on.text(), /Initial Stock/);
});

test('the printed price list leaves stock off when asked, and keeps it by default', () => {
  assert.match(productListHtml(PRODUCTS), /<span>Stock<\/span>/);
  assert.doesNotMatch(productListHtml(PRODUCTS, { stock: false }), /Stock/);
  assert.match(productListHtml(PRODUCTS, { stock: false }), /Price\/case/);
  const text = (bytes) => new TextDecoder().decode(bytes);
  assert.match(text(productListEscPos(PRODUCTS)), /Stock/);
  assert.doesNotMatch(text(productListEscPos(PRODUCTS, { stock: false })), /Stock/);
});
