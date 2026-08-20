// The review modal is for drafts and only drafts: nothing is committed while it is open,
// so every way out of it just returns to the cart (F5 — a dismissal must never become an
// edit, and must never cost the operator work). Reading back an order that already
// exists is a separate, read-only job: History's 👁️ View → OrderViewModal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React } from './render.mjs';

const POSReviewModal = (await import('../src/components/pos/POSReviewModal.jsx')).default;
const OrderViewModal = (await import('../src/components/pos/OrderViewModal.jsx')).default;

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
  const calls = { edit: 0, close: 0, confirm: 0, discard: 0, draft: 0 };
  return [calls, {
    onEdit:    () => { calls.edit += 1; },
    onClose:   () => { calls.close += 1; },
    onConfirm: () => { calls.confirm += 1; },
    onDiscard: () => { calls.discard += 1; },
    onDraft:   () => { calls.draft += 1; },
  }];
};

const labels = (r) =>
  r.all('button').map((b) => b.textContent.replace(/[^A-Za-z&/ ]/g, '').trim()).filter(Boolean);

test('the review modal offers Discard / Draft / Edit Items / Confirm & Print', () => {
  const [calls, handlers] = spies();
  const r = render(React.createElement(POSReviewModal, { order: order(), ...handlers }));

  assert.deepEqual(labels(r), ['Discard', 'Draft', 'Edit Items', 'Confirm & Print']);
  // The header says draft, so nobody reads it as an order that already exists.
  assert.match(r.text(), /📝 Draft #91/);

  const find = (label) => r.all('button').find((b) => b.textContent.includes(label));
  r.click(find('Discard'));
  r.click(find('Draft'));
  r.click(find('Confirm & Print'));
  assert.deepEqual({ discard: calls.discard, draft: calls.draft, confirm: calls.confirm },
    { discard: 1, draft: 1, confirm: 1 });
  assert.ok(r.all('button').every((b) => b.className.includes('min-h-tablet') || b.getAttribute('aria-label')));
});

test('✕, the backdrop, Escape and Edit Items all just return to the cart', () => {
  const [calls, handlers] = spies();
  const r = render(React.createElement(POSReviewModal, { order: order(), ...handlers }));

  r.click(r.byLabel('Close review'));
  r.click(r.container.firstChild);                    // the backdrop itself
  r.press('Escape');
  assert.equal(calls.close, 3);

  r.click(r.all('button').find((b) => b.textContent.includes('Edit Items')));
  assert.equal(calls.edit, 1);

  // Nothing here can create, discard or park the order by accident.
  assert.equal(calls.confirm, 0);
  assert.equal(calls.discard, 0);
  assert.equal(calls.draft, 0);
});

test('the read-only view shows the order and offers nothing but Back', () => {
  let closed = 0;
  const r = render(React.createElement(OrderViewModal, {
    order: order({ status: 'pending' }),
    onClose: () => { closed += 1; },
  }));

  assert.match(r.text(), /Aling Nena Store/);
  assert.match(r.text(), /Coke Sakto 200ml/);
  assert.match(r.text(), /Created/);                  // status, spelled out, not colour-only
  assert.deepEqual(labels(r), ['Back']);              // plus the unlabelled ✕
  for (const word of ['Discard', 'Edit', 'Print', 'Confirm', 'Cancel']) {
    assert.equal(r.text().includes(word), false, `read-only: no ${word} action`);
  }

  r.press('Escape');
  r.click(r.all('button').find((b) => b.textContent.includes('Back')));
  assert.equal(closed, 2, 'Escape and Back both return to whatever opened it');
});
