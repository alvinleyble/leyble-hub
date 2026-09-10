import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs';
import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { SYNC_STATE_KEY } from '../src/offline/keys.js';
import { getReceipt, __clearReceipts } from '../src/offline/receiptHistory.js';
import {
  pollOrderDelta, getSyncSnapshot, __resetSyncState,
} from '../src/offline/sync.js';
import { createForegroundOrderPoller } from '../src/offline/foregroundOrderSync.js';

let realGet;

beforeEach(async () => {
  realGet = api.get;
  await __resetMemoryBackend();
  await __clearReceipts();
  await __resetSyncState();
});

afterEach(() => { api.get = realGet; });

const order = {
  id: 42,
  receipt_number: '1A-00042',
  revision: '7',
  status: 'in_transit',
  customer_id: 1,
  customer_name: 'Aling Nena',
  order_type: 'delivery',
  total_amount: '300.00',
  adjustment: '0.00',
  created_at: '2026-09-09T01:00:00.000Z',
  updated_at: '2026-09-09T01:01:00.000Z',
  items: [],
  personnel: [],
};

test('foreground order delta stores complete snapshots and announces exactly what changed', async () => {
  await nativeStore.setJson(SYNC_STATE_KEY, {
    setup_complete: true,
    orders_backfill_complete: true,
    orders_delta_cursor: '2026-09-09T01:00:00.000000Z|41',
  });
  const paths = [];
  api.get = async (path) => {
    paths.push(path);
    return {
      orders: [order], has_more: false,
      first_cursor: '2026-09-09T01:01:00.000000Z|42',
      next_cursor: '2026-09-09T01:01:00.000000Z|42',
    };
  };

  let detail = null;
  const listener = (event) => { detail = event.detail; };
  window.addEventListener('leyble:orders-changed', listener);
  try {
    const result = await pollOrderDelta();
    assert.equal(result.ordersSynced, 1);
    assert.match(paths[0], /direction=forward/);
    assert.deepEqual(detail.ids, [42]);
    assert.deepEqual(detail.receiptNumbers, ['1A-00042']);
    assert.equal(detail.orders[0].revision, '7');
    assert.equal((await getReceipt('1A-00042')).status, 'in_transit');
    assert.equal(getSyncSnapshot().orderCheck, 'idle');
    assert.equal(getSyncSnapshot().recentlyUpdated, true);
  } finally {
    window.removeEventListener('leyble:orders-changed', listener);
  }
});

function emitter(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    emit(name, value = {}) { listeners.get(name)?.(value); },
  };
}

test('app-wide scheduler polls every 5s, backs off on failure, and wakes immediately on reconnect', async () => {
  const doc = emitter({ visibilityState: 'visible' });
  const win = emitter();
  const scheduled = [];
  let recoveryStarts = 0;
  let calls = 0;
  const poller = createForegroundOrderPoller({
    doc,
    win,
    capacitorApp: null,
    poll: async () => { calls += 1; if (calls === 1) throw new Error('offline'); },
    startRecovery: () => { recoveryStarts += 1; },
    setTimer: (fn, delay) => { const token = { fn, delay }; scheduled.push(token); return token; },
    clearTimer: () => {},
  });

  poller.start();
  const firstTimer = scheduled.shift();
  assert.equal(firstTimer.delay, 5_000);
  await firstTimer.fn();
  assert.equal(recoveryStarts, 1);
  assert.equal(scheduled.at(-1).delay, 10_000);

  win.emit('online');
  assert.equal(scheduled.at(-1).delay, 0, 'confirmed connectivity resumes immediately');
  await scheduled.at(-1).fn();
  assert.equal(scheduled.at(-1).delay, 5_000, 'successful check restores normal cadence');
  poller.stop();
});

test('foreground scheduler pauses while hidden and checks immediately on resume', async () => {
  const doc = emitter({ visibilityState: 'hidden' });
  const scheduled = [];
  const poller = createForegroundOrderPoller({
    doc,
    win: emitter(),
    capacitorApp: null,
    poll: async () => {},
    startRecovery: () => {},
    setTimer: (fn, delay) => { const token = { fn, delay }; scheduled.push(token); return token; },
    clearTimer: () => {},
  });
  poller.start();
  assert.equal(scheduled.length, 0);
  doc.visibilityState = 'visible';
  doc.emit('visibilitychange');
  assert.equal(scheduled.at(-1).delay, 0);
  poller.stop();
});
