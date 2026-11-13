import React, { useState } from 'react';
import { useExistingProduct, changeProductCode, drainOutbox } from '../../offline/outbox.js';
import { useToast } from '../ui/Toast.jsx';

// This is a product question, not an order/customer re-point. Keep that existing
// attention flow separate so no product answer can accidentally change an order.
export default function ProductCodeClashCard({ record, onResolved }) {
  const { addToast } = useToast();
  const [changing, setChanging] = useState(false);
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const existing = record.product_clash.existing_product;
  const buttonClass = 'min-h-[48px] rounded-lg border border-slate-500 px-4 py-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50';

  const resolve = async (action) => {
    setSaving(true);
    try {
      await action();
      // The answer is stored first; a lost connection leaves it safely queued.
      drainOutbox().catch(() => {});
      await onResolved();
    } catch (err) {
      addToast(err.message || 'Could not resolve the product code.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid={`attention-record-${record.id}`} className="space-y-4 rounded-xl border border-amber-500 bg-slate-900 p-4 text-base text-slate-100">
      <h3 className="font-bold text-amber-200">Product code already exists</h3>
      <p className="break-words">Code: <strong>{record.product_clash.sku}</strong></p>
      <p className="break-words">This device: <strong>{record.payload.name}</strong></p>
      <p className="break-words">Server product: <strong>{existing.name}</strong></p>
      <p className="text-sm text-slate-300">Using the existing product keeps its saved details. The price, initial stock and other values entered on this device will not be applied.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonClass} disabled={saving} onClick={() => resolve(() => useExistingProduct(record.id))}>Use existing product</button>
        <button type="button" className={buttonClass} disabled={saving} onClick={() => setChanging(true)}>Change code</button>
      </div>
      {changing && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); resolve(() => changeProductCode(record.id, code)); }}>
          <label htmlFor={`product-code-${record.id}`} className="block font-semibold">New product code</label>
          <input id={`product-code-${record.id}`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={100} disabled={saving}
            className="h-12 w-full rounded-lg border border-slate-500 bg-slate-800 px-3 text-base text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" />
          <button type="submit" className={buttonClass} disabled={saving || !code.trim()}>Save new code</button>
        </form>
      )}
    </div>
  );
}
