// F5 — the review modal must never turn a dismissal into an edit, and backing out must
// never cost the operator anything. Since the review now happens on the **draft**,
// dismissing it simply returns to the cart; only a Created order gets a confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React } from './render.mjs';

const POSReviewModal       = (await import('../src/components/pos/POSReviewModal.jsx')).default;
const POSReviewExitConfirm = (await import('../src/components/pos/POSReviewExitConfirm.jsx')).default;

const order = (over = {}) => ({
  id: 91,
  status: 'draft',
  order_type: 'delivery',
  customer_name: 'Aling Nena Store',
  customer_type: 'wholesaler',
  adjustment: 0,
  items: [{ id: 1, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs',
            quantity: 2, unit_price: 260, unit_deposit_fee: 0, units_per_case: 24 }],
  ...over,
});

const spies = () => {
  const calls = { edit: 0, close: 0, confirm: 0, discard: 0, draft: 0, newOrder: 0 };
  return [calls, {
    onEdit:     () => { calls.edit += 1; },
    onClose:    () => { calls.close += 1; },
    onConfirm:  () => { calls.confirm += 1; },
    onDiscard:  () => { calls.discard += 1; },
    onDraft:    () => { calls.draft += 1; },
    onNewOrder: () => { calls.newOrder += 1; },
  }];
};

const review = (handlers, over) =>
  render(React.createElement(POSReviewModal, { order: order(over), ...handlers }));

const labels = (r) =>
  r.all('button').map((b) => b.textContent.replace(/[^A-Za-z&/ ]/g, '').trim()).filter(Boolean);

test('F5: ✕, the backdrop and Escape close the review — none of them start an edit', () => {
  const [calls, handlers] = spies();
  const r = review(handlers);

  r.click(r.byLabel('Close review'));
  assert.equal(calls.close, 1);

  r.click(r.container.firstChild);          // the backdrop itself
  assert.equal(calls.close, 2);

  r.press('Escape');
  assert.equal(calls.close, 3);

  assert.equal(calls.edit, 0, 'dismissing must never drop the operator into edit mode');
});

test('a draft review offers Discard / Draft / Edit / Confirm & Print', () => {
  const [calls, handlers] = spies();
  const r = review(handlers);

  assert.deepEqual(labels(r), ['Discard', 'Draft', 'Edit Items', 'Confirm & Print']);
  // The header says draft, so nobody reads it as an order that already exists.
  assert.match(r.text(), /📝 Draft #91/);

  const find = (label) => r.all('button').find((b) => b.textContent.includes(label));
  r.click(find('Discard'));
  r.click(find('Draft'));
  r.click(find('Edit Items'));
  r.click(find('Confirm & Print'));
  assert.equal(calls.discard, 1);
  assert.equal(calls.draft, 1);
  assert.equal(calls.edit, 1);
  assert.equal(calls.confirm, 1);
  assert.ok(r.all('button').every((b) => b.className.includes('min-h-tablet') || b.getAttribute('aria-label')));
});

test('an already-created order is never offered Discard — only print, edit or a new order', () => {
  const [calls, handlers] = spies();
  const r = review(handlers, { status: 'pending' });

  assert.deepEqual(labels(r),
    ['Edit Items / Back', 'New Order / Skip Print', 'Print Receipt  Copies']);
  assert.equal(r.text().includes('Discard'), false);
  assert.match(r.text(), /Order #91/);
  assert.equal(r.text().includes('Draft #91'), false);

  r.click(r.all('button').find((b) => b.textContent.includes('Print Receipt')));
  assert.equal(calls.confirm, 1, 'the primary action stays a plain reprint');
});

test('dismissing a created order asks, and neither answer discards it', () => {
  const calls = { keep: 0, back: 0 };
  const r = render(React.createElement(POSReviewExitConfirm, {
    orderId: 91,
    onKeep: () => { calls.keep += 1; },
    onBack: () => { calls.back += 1; },
  }));

  const buttons = r.all('button');
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, '').trim()),
    ['Keep', 'Go Back']);
  // "Close" is the settlement step in this domain (returns counted, order done), and a
  // Created order can only be cancelled — from History, never here.
  assert.equal(r.container.querySelector('h2').textContent, 'Order #91');
  assert.equal(/close/i.test(r.text()), false);
  assert.equal(r.text().includes('Discard'), false);
  assert.match(r.text(), /cancel it from History/);

  r.click(buttons[0]);
  r.click(buttons[1]);
  assert.deepEqual(calls, { keep: 1, back: 1 });

  assert.ok(buttons.every((b) => b.className.includes('min-h-tablet')));
  assert.ok(buttons.every((b) => b.getAttribute('aria-label')));

  r.press('Escape');
  assert.equal(calls.back, 2, 'Escape backs out of the dialog, not out of the order');
});
