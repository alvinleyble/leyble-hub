// F5 — dismissing the Review modal must mean "close", not "edit", and the close must
// offer three choices so an accidental backdrop tap never throws the print buffer away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React } from './render.mjs';

const POSReviewModal      = (await import('../src/components/pos/POSReviewModal.jsx')).default;
const POSReviewExitConfirm = (await import('../src/components/pos/POSReviewExitConfirm.jsx')).default;

const order = {
  id: 91,
  status: 'pending',
  order_type: 'delivery',
  customer_name: 'Aling Nena Store',
  customer_type: 'wholesaler',
  adjustment: 0,
  items: [{ id: 1, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs',
            quantity: 2, unit_price: 260, unit_deposit_fee: 0, units_per_case: 24 }],
};

const spies = () => {
  const calls = { edit: 0, close: 0, print: 0, newOrder: 0 };
  return [calls, {
    onEdit:     () => { calls.edit += 1; },
    onClose:    () => { calls.close += 1; },
    onPrint:    () => { calls.print += 1; },
    onNewOrder: () => { calls.newOrder += 1; },
  }];
};

const review = (handlers) => render(React.createElement(POSReviewModal, { order, ...handlers }));

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

test('F5: only the explicit "Edit Items / Back" button starts an edit', () => {
  const [calls, handlers] = spies();
  const r = review(handlers);

  const edit = r.all('button').find((b) => b.textContent.includes('Edit Items / Back'));
  r.click(edit);
  assert.equal(calls.edit, 1);
  assert.equal(calls.close, 0);
});

test('F5: the dismiss dialog offers three one-word choices, wired to their own actions', () => {
  const calls = { discard: 0, leave: 0, back: 0 };
  const r = render(React.createElement(POSReviewExitConfirm, {
    orderId: 91,
    onDiscard: () => { calls.discard += 1; },
    onLeave:   () => { calls.leave += 1; },
    onBack:    () => { calls.back += 1; },
  }));

  const buttons = r.all('button');
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, '').trim()),
    ['Discard', 'Draft', 'Go Back']);
  // Copy must not promise deletion — a saved order can only ever be cancelled.
  assert.equal(r.text().includes('Delete'), false);
  // The stock consequence is stated once, in the body, not on every button.
  assert.match(r.text(), /Discard puts the stock back/);

  const find = (label) => buttons.find((b) => b.textContent.includes(label));
  r.click(find('Discard'));
  r.click(find('Draft'));
  r.click(find('Go Back'));
  assert.deepEqual(calls, { discard: 1, leave: 1, back: 1 });

  // Every choice is a tablet-sized target (min-h-tablet = 52px) and carries a spoken
  // label, since the visible text is one word.
  assert.ok(buttons.every((b) => b.className.includes('min-h-tablet')));
  assert.ok(buttons.every((b) => b.getAttribute('aria-label')));

  r.press('Escape');
  assert.equal(calls.back, 2, 'Escape backs out of the dialog, not out of the order');
});

test('F5: an already-cancelled order is offered no discard choice', () => {
  const r = render(React.createElement(POSReviewExitConfirm, {
    orderId: 91, canDiscard: false, onDiscard: () => {}, onLeave: () => {}, onBack: () => {},
  }));
  const buttons = r.all('button');
  assert.deepEqual(buttons.map((b) => b.textContent.replace(/[^A-Za-z ]/g, '').trim()),
    ['Draft', 'Go Back']);
  assert.equal(r.text().includes('Discard'), false);
});
