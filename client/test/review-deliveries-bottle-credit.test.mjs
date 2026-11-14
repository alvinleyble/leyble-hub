// Migration 051 on the Review Deliveries queue: the listed price already includes every
// bottle's deposit. Counting starts at no bottles returned, so the total is the same as
// before closing; a returned bottle comes off as one "Bottles returned N × fee" line, the
// same words and numbers the closing receipt prints.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import { generateEscPos } from '../src/pages/orders/escposReceipt.js';

const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

let saved = {};

beforeEach(async () => {
  saved = { get: api.get };
  await __resetMemoryBackend();
  await __clearReceipts();
  await __clearOutbox();
});

afterEach(() => { Object.assign(api, saved); });

const delivered = () => ({
  id: 42,
  receipt_number: '1A-00042',
  revision: '5',
  status: 'completed',
  order_type: 'delivery',
  customer_id: 7,
  customer_name: 'Aling Nena',
  created_at: '2026-09-09T01:00:00.000Z',
  adjustment: 0,
  adjustment_reason: null,
  delivery_fee_charged: 50,
  total_amount: 641,
  notes: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Red Horse Grande 1L', sku: 'RH Grande 1L', category: 'Beer',
    unit: 'cs', quantity: 1, unit_price: 641, unit_deposit_fee: 4.5,
    units_per_case: 6, bottles_returned: 0, requires_bottle_return: true,
  }],
  personnel: [],
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

function renderQueue(initial) {
  api.get = async (path) => (path === `/orders/${initial.id}` ? initial : []);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ToastProvider, null,
      React.createElement(ReviewQueueModal, { orderIds: [initial.id], mode: 'delivered', onClose: () => {} })));
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

const plain = (bytes) => Array.from(bytes).map((b) => String.fromCharCode(b)).join('')
  .replace(/\x1BE[\x00\x01]/g, '');

test('Review Deliveries: no bottles returned by default, then one credit line matching the receipt', async () => {
  const order = delivered();
  const r = renderQueue(order);
  await settle();

  const input = r.container.querySelector('input[aria-label="Bottles returned for RH Grande 1L"]');
  assert.ok(input, 'the bottle count rendered');
  assert.equal(input.value, '0', 'no bottles returned is the default');
  assert.equal(r.container.textContent.includes('Bottles returned 0'), false, 'nothing extra with none back');
  assert.match(r.container.textContent, /Items subtotal₱641\.00Delivery Fee₱50\.00Order Total₱691\.00/);
  for (const gone of ['Deposit subtotal', 'unreturned', 'no deposit', 'Net deposit']) {
    assert.equal(r.container.textContent.includes(gone), false, gone);
  }

  const reactProps = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  act(() => { input[reactProps].onChange({ target: { value: '6' } }); });

  // The product at its listed price, then the credit, as on paper.
  assert.match(r.container.textContent, /RH Grande 1L — 1 cs₱641\.00Bottles returned 6 × ₱4\.50−₱27\.00/);
  assert.match(r.container.textContent, /Items subtotal₱614\.00Delivery Fee₱50\.00Order Total₱664\.00/);
  const paper = plain(generateEscPos(order, { 3: '6' }));
  assert.match(paper, /  Bottles returned 6 x PHP4\.50 +-PHP27\.00\n/);
  assert.match(paper, /\nFINAL TOTAL +PHP664\.00\n/);
  r.unmount();
});
