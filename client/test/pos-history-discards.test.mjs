// Discarding at the review stage is an abandonment, not a business decision: those
// orders are cancelled with the stock put back, but must never clutter POS History.
// A deliberate cancel from History stays visible there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';

const { ToastProvider }  = await import('../src/components/ui/Toast.jsx');
const POSHistoryModal    = (await import('../src/components/pos/POSHistoryModal.jsx')).default;

const withFetch = (handler) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    return {
      ok: true, status: 200,
      json: async () => handler(String(url)) ?? [],
    };
  };
  return calls;
};

test('POS History asks the API to leave discarded orders out', async () => {
  const calls = withFetch(() => []);
  const r = render(React.createElement(ToastProvider, null,
    React.createElement(POSHistoryModal, {
      onClose: () => {}, onEdit: () => {}, onReprint: () => {}, onChanged: () => {},
    })));
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  r.unmount();

  const listCalls = calls.filter((c) => c.url.includes('/orders?'));
  assert.equal(listCalls.length, 2, 'History fetches Created and Cancelled');
  assert.ok(listCalls.some((c) => c.url.includes('status=pending')));
  assert.ok(listCalls.some((c) => c.url.includes('status=cancelled')));
  assert.ok(listCalls.every((c) => c.url.includes('exclude_discarded=1')),
    'both fetches must exclude discarded orders');
});
