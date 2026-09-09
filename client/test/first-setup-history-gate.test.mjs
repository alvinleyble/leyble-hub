// ADR 0019 — the first-setup gate.
//
// Slice 3.2 unlocked a brand-new tablet the moment products/customers/personnel
// landed and let the complete order history stream in behind an already-open app.
// Field review reversed that: a tablet that can already take an order but has no
// history to check it against is exactly the "unavailable required data" state ADR
// 0015 §5 exists to prevent everywhere else. ADR 0019 settled that the app stays gated
// behind one truthful setup screen until the order history is ALSO complete — see
// docs/adr/0019-order-revision-and-delta-sync.md and CONTEXT.md's "Complete first
// setup" / "First-setup progress" entries.
//
// These tests cover exactly the four acceptance scenarios: a new tablet, a resumed
// partial first setup, unlocking only after the full history lands, and an already
// initialized tablet that must never be regressed into this gate. The underlying
// resumable backfill and cursor persistence (interruption safety, merge-never-replace)
// are already covered by v3-s3-2-offline-full-sync.test.mjs and are not re-proven here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { SYNC_STATE_KEY } from '../src/offline/keys.js';
import {
  runSync, getSyncState, getSyncSnapshot, isFirstSetup, subscribeSync, useSyncGate,
  __resetSyncState,
} from '../src/offline/sync.js';
import { putOrderSnapshot, listReceipts, __clearReceipts } from '../src/offline/receiptHistory.js';
import { getCachedProducts, getCachedCustomers, getCachedPersonnel } from '../src/offline/catalogue.js';

const FirstSetupGateScreen = (await import('../src/components/setup/FirstSetupGateScreen.jsx')).default;

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post };
  await __resetMemoryBackend();
  await __clearReceipts();
  await __resetSyncState();
});

afterEach(() => {
  Object.assign(api, saved);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const PRODUCTS  = [{ id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
  base_wholesale_price: 300, units_per_case: 24, is_active: true, updated_at: '2026-08-20T00:00:00.000Z' }];
const CUSTOMERS = [{ id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true, updated_at: '2026-08-19T00:00:00.000Z' }];
const PERSONNEL = [{ id: 3, full_name: 'Luis Reyes', is_active: true, updated_at: '2026-08-18T00:00:00.000Z' }];

const serverOrder = (id, overrides = {}) => ({
  id,
  receipt_number: null,
  created_at: `2026-08-${String(10 + id).padStart(2, '0')}T02:00:00.000Z`,
  updated_at: `2026-08-${String(10 + id).padStart(2, '0')}T02:00:00.000Z`,
  status: 'completed',
  customer_id: 5,
  customer_name: 'Aling Nena',
  order_type: 'delivery',
  total_amount: 300,
  adjustment: 0,
  items: [{ id: id * 10, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8',
            unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0, units_per_case: 24,
            requires_bottle_return: false, bottles_returned: 0 }],
  personnel: [],
  ...overrides,
});

/**
 * A stand-in server recording every path asked for, so a test can assert on the SHAPE
 * of the conversation (full pull vs delta, which cursor was requested) as well as the
 * result. `orderDelayMs` lets a test observe an in-between state before history lands;
 * `failOrdersAfterPages` simulates a dropped connection partway through the backfill.
 */
function stubServer({
  orders = [], products = PRODUCTS, customers = CUSTOMERS, personnel = PERSONNEL,
  pageSize = 100, orderGate = null, failOrdersAfterPages = Infinity,
} = {}) {
  const calls = [];
  let backfillPages = 0;
  api.get = async (path) => {
    calls.push(path);
    if (path.startsWith('/orders/sync')) {
      const params = new URLSearchParams(path.split('?')[1] || '');
      const forward = params.get('direction') === 'forward';
      if (!forward) {
        backfillPages += 1;
        if (backfillPages > failOrdersAfterPages) throw new Error('Failed to fetch');
      }
      // A test-controlled gate rather than a fixed delay: a real timer racing another
      // real timer is exactly the kind of assertion that goes flaky under CPU
      // contention from the rest of the suite running alongside it.
      if (orderGate) await orderGate;
      const cursor = params.get('cursor');
      const sorted = [...orders].sort((a, b) =>
        String(a.updated_at).localeCompare(String(b.updated_at)) || a.id - b.id);
      let pool = forward ? sorted : sorted.reverse();
      if (cursor) {
        const [at, id] = [cursor.slice(0, cursor.lastIndexOf('|')), Number(cursor.slice(cursor.lastIndexOf('|') + 1))];
        pool = pool.filter((o) => {
          const cmp = String(o.updated_at).localeCompare(at) || (o.id - id);
          return forward ? cmp > 0 : cmp < 0;
        });
      }
      const page = pool.slice(0, pageSize);
      const cursorFor = (o) => (o ? `${o.updated_at}|${o.id}` : null);
      return {
        orders: page,
        has_more: pool.length > pageSize,
        first_cursor: cursorFor(page[0]),
        next_cursor: cursorFor(page[page.length - 1]),
      };
    }
    const since = new URLSearchParams(path.split('?')[1] || '').get('updated_since');
    const pick = path.startsWith('/products') ? products
      : path.startsWith('/personnel') ? personnel
      : path.startsWith('/customers') ? customers
      : [];
    return since ? pick.filter((r) => String(r.updated_at) > since) : pick;
  };
  return calls;
}

function GateHost() {
  const sync = useSyncGate();
  return sync.blocking
    ? React.createElement(FirstSetupGateScreen)
    : React.createElement('div', null, 'APP UNLOCKED');
}

// ── 1. A new tablet ────────────────────────────────────────────────────────────────

test('a new tablet stays gated while essentials land, and only unlocks once the complete order history has downloaded', async () => {
  // A test-controlled gate on the order-history fetch, held closed until this test
  // deliberately opens it — deterministic, unlike racing a fixed delay against
  // whatever the rest of the suite is doing to the event loop at the same moment.
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  stubServer({ orders: [serverOrder(1), serverOrder(2)], orderGate: historyGate });

  assert.equal(await isFirstSetup(), true, 'a device with no sync state has never been set up');

  const pending = runSync({ trigger: 'login' });

  // runSync()'s own first `await` means its opening publish (phase: 'setup',
  // essentialsReady: false) has not landed yet at this exact point — a bare
  // `!getSyncSnapshot().essentialsReady` check here would still be reading the
  // reset default (`true`) and could pass for the wrong reason. Force one real tick
  // first, then poll for essentials to land (no artificial delay of their own, but
  // still real awaits) while the order-history fetch stays held on the gate.
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 100 && !getSyncSnapshot().essentialsReady; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(getSyncSnapshot().essentialsReady, true, 'products/customers/personnel land');
  assert.equal(getSyncSnapshot().phase, 'setup');
  assert.equal(getSyncSnapshot().firstSetupPending, true,
    'the app must not unlock after only products, customers and personnel arrive');
  assert.equal((await listReceipts()).length, 0,
    'the order history fetch is still held open — nothing has landed yet');

  releaseHistory();
  await pending;

  assert.equal(getSyncSnapshot().firstSetupPending, false, 'the complete history has now landed — the gate releases');
  assert.equal(getSyncSnapshot().phase, 'idle');
  assert.equal(await isFirstSetup(), false);
  assert.deepEqual((await listReceipts()).map((o) => o.id).sort(), [1, 2]);
  assert.deepEqual((await getCachedProducts()).map((p) => p.id), [1]);
  assert.deepEqual((await getCachedCustomers()).map((c) => c.id), [5]);
  assert.deepEqual((await getCachedPersonnel()).map((p) => p.id), [3]);
});

// ── 2. A resumed partial first setup ────────────────────────────────────────────────

test('a first setup resumed after essentials already landed fetches them as a delta, resumes the backfill from its saved cursor, and stays gated until it finishes', async () => {
  // The state a tablet is left in when its essentials pull succeeded but the order
  // backfill was interrupted after one page — the exact "recovery from a previously
  // interrupted first history download" the acceptance criteria calls out.
  await nativeStore.setJson(SYNC_STATE_KEY, {
    setup_complete: true,
    reference_watermarks: {
      products: '2026-08-20T00:00:00.000Z',
      customers: '2026-08-19T00:00:00.000Z',
      personnel: '2026-08-18T00:00:00.000Z',
    },
    orders_delta_cursor: null,
    orders_backfill_cursor: '2026-08-14T02:00:00.000Z|4',
    orders_backfill_complete: false,
    last_sync_completed_at: 0,
  });
  await nativeStore.setJson('v25.catalogue.products', PRODUCTS);
  await nativeStore.setJson('v25.catalogue.customers', CUSTOMERS);
  await nativeStore.setJson('v25.catalogue.personnel', PERSONNEL);
  await putOrderSnapshot(serverOrder(4));

  assert.equal(await isFirstSetup(), true, 'essentials alone do not make this device "set up"');

  const calls = stubServer({ orders: [serverOrder(1), serverOrder(2), serverOrder(3), serverOrder(4)] });

  const seen = [];
  const unsubscribe = subscribeSync((snap) => seen.push({ ...snap }));
  await runSync({ trigger: 'login' });
  unsubscribe();

  assert.ok(calls.every((c) => !c.startsWith('/products') || c.includes('updated_since')),
    'essentials already held must be fetched as a delta — not a second full catalogue pull');
  assert.ok(calls.every((c) => !c.startsWith('/customers') || c.includes('updated_since')));
  assert.ok(calls.every((c) => !c.startsWith('/personnel') || c.includes('updated_since')));

  const firstBackfillCall = calls.find((c) => c.startsWith('/orders/sync') && c.includes('direction=back'));
  assert.ok(firstBackfillCall?.includes(encodeURIComponent('2026-08-14T02:00:00.000Z|4')),
    'the backfill resumes from its saved cursor rather than restarting from the newest page');

  assert.equal(seen[0].firstSetupPending, true, 'the run starts gated — the resume is still a first setup');
  assert.equal(getSyncSnapshot().firstSetupPending, false, 'the backfill finishing is what releases the gate');
  assert.equal((await getSyncState()).orders_backfill_complete, true);
  assert.deepEqual((await listReceipts()).map((o) => o.id).sort(), [1, 2, 3, 4],
    'the already-held order plus everything the resumed backfill still owed');
  assert.equal(await isFirstSetup(), false);
});

// ── 3. Unlock only after the full history — including an interrupt/resume cycle ────

test('an interrupted first setup never falsely unlocks, shows the truthful waiting screen, and completes only once connectivity resumes', async () => {
  const orders = [serverOrder(1), serverOrder(2), serverOrder(3), serverOrder(4)];
  stubServer({ orders, pageSize: 2, failOrdersAfterPages: 1 });

  await runSync({ trigger: 'login' });

  assert.equal(getSyncSnapshot().firstSetupPending, true,
    'the line dropped mid-backfill — the gate must not report itself complete');
  assert.equal(getSyncSnapshot().phase, 'idle', 'the run ends rather than hanging, so a retry can be attempted');
  assert.equal(await isFirstSetup(), true);
  assert.equal((await listReceipts()).length, 2, 'the page that did land is kept');

  const host = render(React.createElement(GateHost));
  assert.doesNotMatch(host.text(), /APP UNLOCKED/, 'the normal app must not be exposed with incomplete required history');
  assert.match(host.text(), /interrupted/i);
  const retryButton = host.all('button').find((b) => b.textContent.includes('Retry'));
  assert.ok(retryButton, 'ADR 0019: a visible Retry action');

  // Connectivity returns. Tapping Retry (a deliberate, never-throttled trigger) is what
  // ADR 0019 asks for instead of only waiting on the next automatic reconnect.
  stubServer({ orders });
  await act(async () => {
    retryButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });

  assert.equal(getSyncSnapshot().firstSetupPending, false, 'the resumed backfill now completes the gate');
  assert.deepEqual((await listReceipts()).map((o) => o.id).sort(), [1, 2, 3, 4]);
  assert.match(host.text(), /APP UNLOCKED/, 'the same screen now renders the normal app');

  host.unmount();
});

// ── 4. An already initialized tablet ────────────────────────────────────────────────

test('an already initialized tablet is usable immediately and is never regressed into the first-setup gate', async () => {
  await nativeStore.setJson(SYNC_STATE_KEY, {
    setup_complete: true,
    reference_watermarks: {
      products: '2026-08-20T00:00:00.000Z',
      customers: '2026-08-19T00:00:00.000Z',
      personnel: '2026-08-18T00:00:00.000Z',
    },
    orders_delta_cursor: '2026-08-12T02:00:00.000Z|2',
    orders_backfill_cursor: '2026-08-11T02:00:00.000Z|1',
    orders_backfill_complete: true,
    last_sync_completed_at: 0,
  });
  await nativeStore.setJson('v25.catalogue.products', PRODUCTS);
  await nativeStore.setJson('v25.catalogue.customers', CUSTOMERS);
  await nativeStore.setJson('v25.catalogue.personnel', PERSONNEL);
  await putOrderSnapshot(serverOrder(1));
  await putOrderSnapshot(serverOrder(2));

  assert.equal(await isFirstSetup(), false);
  assert.equal(getSyncSnapshot().firstSetupPending, false,
    'usable immediately — the gate must not engage even for the instant before the network call resolves');

  const host = render(React.createElement(GateHost));
  assert.match(host.text(), /APP UNLOCKED/);

  stubServer({ orders: [serverOrder(1), serverOrder(2), serverOrder(3)] });
  const seen = [];
  const unsubscribe = subscribeSync((snap) => seen.push({ ...snap }));
  await act(async () => { await runSync({ trigger: 'login' }); });
  unsubscribe();

  assert.ok(seen.every((s) => s.firstSetupPending === false),
    'a routine login sync on an initialized tablet must never flip the gate on');
  assert.match(host.text(), /APP UNLOCKED/, 'still unlocked throughout');

  host.unmount();
});
