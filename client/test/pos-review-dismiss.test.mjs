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

test('F5: the dismiss dialog offers three choices, and voiding says the order is kept as Cancelled', () => {
  const calls = { void: 0, keep: 0, cont: 0 };
  const r = render(React.createElement(POSReviewExitConfirm, {
    orderId: 91,
    customerName: 'Aling Nena Store',
    onVoid:     () => { calls.void += 1; },
    onKeep:     () => { calls.keep += 1; },
    onContinue: () => { calls.cont += 1; },
  }));

  const buttons = r.all('button');
  assert.equal(buttons.length, 3);
  // Copy must not promise deletion — a saved order can only ever be cancelled.
  assert.match(r.text(), /put the stock back\?.*stay in History as Cancelled/s);
  assert.equal(r.text().includes('Delete'), false);

  const find = (label) => buttons.find((b) => b.textContent.includes(label));
  r.click(find('Void / Trash this order'));
  r.click(find('Keep & Print Later'));
  r.click(find('Continue Reviewing'));
  assert.deepEqual(calls, { void: 1, keep: 1, cont: 1 });

  // Every choice is a tablet-sized target (min-h-tablet = 52px).
  assert.ok(buttons.every((b) => b.className.includes('min-h-tablet')));

  r.press('Escape');
  assert.equal(calls.cont, 2, 'Escape backs out of the dialog, not out of the order');
});

test('F5: an already-cancelled order is offered no void choice', () => {
  const r = render(React.createElement(POSReviewExitConfirm, {
    orderId: 91, canVoid: false, onVoid: () => {}, onKeep: () => {}, onContinue: () => {},
  }));
  const buttons = r.all('button');
  assert.equal(buttons.length, 2);
  assert.equal(r.text().includes('Void / Trash'), false);
});
