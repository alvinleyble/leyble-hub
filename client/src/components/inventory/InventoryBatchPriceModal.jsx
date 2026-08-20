import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD = `w-full h-11 rounded-lg border border-v2-border bg-v2-bg px-3 text-base text-v2-text
               placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const round2 = (n) => Math.round(n * 100) / 100;

// Resolves a uniform adjustment (percent/fixed/set, increase/decrease) against one
// product's current price. Negative results are clamped to 0 but flagged as clamped
// so the preview can call it out instead of silently changing what the owner typed.
function computeUniformPrice(current, adjType, adjDirection, adjValue) {
  const val = Number(adjValue) || 0;
  let next;
  if (adjType === 'set') {
    next = val;
  } else if (adjType === 'percent') {
    const delta = current * (val / 100);
    next = adjDirection === 'decrease' ? current - delta : current + delta;
  } else {
    next = adjDirection === 'decrease' ? current - val : current + val;
  }
  return { clamped: Math.max(0, round2(next)), wasClamped: next < 0 };
}

const ADJ_TYPES = [
  { value: 'percent', label: 'Percent (%)' },
  { value: 'fixed',   label: 'Fixed (₱)' },
  { value: 'set',     label: 'Set to (₱)' },
];

const ADJ_DIRECTIONS = [
  { value: 'increase', label: '+ Increase' },
  { value: 'decrease', label: '− Decrease' },
];

function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map(({ value: v, label }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`min-h-[44px] flex-1 rounded-lg border text-sm font-bold transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
            ${value === v
              ? 'border-v2-accent-strong bg-v2-accent-strong text-white'
              : 'border-v2-border bg-v2-bg text-v2-muted hover:bg-v2-raised'
            }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// V2 dark-themed batch price edit — same uniform/individual math as V1's
// BatchPriceEditModal, but the audit reason is REQUIRED (proposal §3, Slice 2
// priority item): the owners open Inventory mainly to change prices in bulk.
export default function InventoryBatchPriceModal({ products, onClose, onSaved }) {
  const { addToast } = useToast();

  const [mode, setMode]             = useState('uniform'); // 'uniform' | 'individual'
  const [adjType, setAdjType]       = useState('percent');
  const [adjDirection, setAdjDirection] = useState('increase');
  const [adjValue, setAdjValue]     = useState('');
  const [individualPrices, setIndividualPrices] = useState(() =>
    Object.fromEntries(products.map((p) => [p.id, String(p.base_wholesale_price)]))
  );
  const [reason, setReason]         = useState('');
  const [saving, setSaving]         = useState(false);
  const [submitError, setSubmitError] = useState('');

  const setIndividualPrice = (id) => (e) => {
    setIndividualPrices((prev) => ({ ...prev, [id]: e.target.value }));
  };

  const rows = products.map((product) => {
    const current = Number(product.base_wholesale_price);

    if (mode === 'individual') {
      const raw = individualPrices[product.id];
      if (raw === '' || raw === undefined || isNaN(Number(raw))) {
        return { product, current, next: null, wasClamped: false, invalid: true };
      }
      const num = Number(raw);
      return { product, current, next: Math.max(0, round2(num)), wasClamped: num < 0, invalid: false };
    }

    const { clamped, wasClamped } = computeUniformPrice(current, adjType, adjDirection, adjValue);
    return { product, current, next: clamped, wasClamped, invalid: false };
  });

  const handleSave = async () => {
    setSubmitError('');

    if (!reason.trim()) {
      setSubmitError('Reason is required for the audit trail.');
      return;
    }
    if (rows.some((r) => r.invalid)) {
      setSubmitError('Enter a valid price for every product before saving.');
      return;
    }

    const updates = rows
      .filter((r) => Number(r.next) !== Number(r.current))
      .map((r) => ({ id: r.product.id, new_price: r.next }));

    if (updates.length === 0) {
      setSubmitError('No prices would change.');
      return;
    }

    setSaving(true);
    try {
      const res = await api.patch('/products/batch-price', {
        updates,
        reason: reason.trim(),
      });
      addToast(`${res.count} product price${res.count === 1 ? '' : 's'} updated.`, 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to update prices.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog" aria-modal="true" aria-labelledby="batch-price-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-8 flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <h2 id="batch-price-title" className="text-xl font-bold text-v2-text">
            Batch Edit Prices ({products.length} product{products.length === 1 ? '' : 's'})
          </h2>
          <button
            onClick={onClose} aria-label="Close" disabled={saving}
            className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Mode toggle */}
          <div className="mb-5">
            <SegmentedControl
              options={[
                { value: 'uniform',    label: 'Uniform adjustment' },
                { value: 'individual', label: 'Individual prices' },
              ]}
              value={mode}
              onChange={setMode}
            />
          </div>

          {mode === 'uniform' && (
            <div className="mb-5 rounded-xl border border-v2-border bg-v2-bg p-4">
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <span className="mb-1.5 block text-sm font-bold text-v2-muted">Adjustment type</span>
                  <SegmentedControl options={ADJ_TYPES} value={adjType} onChange={setAdjType} />
                </div>

                {adjType !== 'set' && (
                  <div>
                    <span className="mb-1.5 block text-sm font-bold text-v2-muted">Direction</span>
                    <SegmentedControl options={ADJ_DIRECTIONS} value={adjDirection} onChange={setAdjDirection} />
                  </div>
                )}
              </div>

              <label className="mb-1.5 block text-sm font-bold text-v2-muted" htmlFor="batch-adj-value">
                {adjType === 'percent' ? 'Percent' : adjType === 'set' ? 'New price (₱)' : 'Amount (₱)'}
              </label>
              <input
                id="batch-adj-value"
                type="number" min="0" step="0.01" value={adjValue}
                onChange={(e) => setAdjValue(e.target.value)}
                className={FIELD}
                placeholder={adjType === 'percent' ? 'e.g. 5' : 'e.g. 2.00'}
              />
            </div>
          )}

          {/* Preview / individual entry table */}
          <div className="mb-5 overflow-hidden rounded-lg border border-v2-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-v2-border bg-v2-bg text-xs uppercase tracking-wider text-v2-muted">
                  <th className="px-4 py-2 text-left font-bold">Product</th>
                  <th className="hidden px-4 py-2 text-left font-bold sm:table-cell">SKU</th>
                  <th className="px-4 py-2 text-right font-bold">Current</th>
                  <th className="px-4 py-2 text-right font-bold">New Price</th>
                  <th className="px-4 py-2 text-right font-bold">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ product, current, next, wasClamped, invalid }) => {
                  const delta = invalid ? null : round2(next - current);
                  return (
                    <tr key={product.id} className="border-t border-v2-border">
                      <td className="px-4 py-3 font-semibold text-v2-text">{product.name}</td>
                      <td className="hidden px-4 py-3 font-mono text-v2-muted sm:table-cell">{product.sku ?? '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-v2-muted">{PHP(current)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {mode === 'individual' ? (
                          <input
                            type="number" min="0" step="0.01"
                            value={individualPrices[product.id] ?? ''}
                            onChange={setIndividualPrice(product.id)}
                            aria-label={`New price for ${product.name}`}
                            aria-invalid={invalid || undefined}
                            className="h-11 w-28 rounded-lg border border-v2-border bg-v2-bg px-3 text-right
                                       text-base text-v2-text focus:outline-none
                                       focus-visible:ring-2 focus-visible:ring-v2-accent"
                          />
                        ) : (
                          <span className="font-bold text-v2-text">{PHP(next)}</span>
                        )}
                        {wasClamped && (
                          <p className="mt-0.5 text-xs font-semibold text-amber-400">Clamped to ₱0.00</p>
                        )}
                        {invalid && (
                          <p className="mt-0.5 text-xs font-semibold text-red-400">Enter a price</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {invalid ? (
                          <span className="text-v2-muted">—</span>
                        ) : delta === 0 ? (
                          <span className="font-semibold text-v2-muted">No change</span>
                        ) : (
                          <span className={`font-semibold ${delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {delta > 0 ? `+${PHP(delta)}` : `− ${PHP(Math.abs(delta))}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <label className="mb-1.5 block text-sm font-bold text-v2-muted" htmlFor="batch-reason">
            Reason <span className="text-red-400">*</span>
            <span className="ml-1 font-normal normal-case text-v2-muted">— required, applied to every product's audit log entry</span>
          </label>
          <input
            id="batch-reason"
            type="text" value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={FIELD}
            placeholder="e.g. Supplier price increase Q3"
            aria-required="true"
          />

          {submitError && (
            <p role="alert" className="mt-3 text-sm font-semibold text-red-400">{submitError}</p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-v2-border px-6 py-4">
          <button
            type="button" onClick={onClose} disabled={saving}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                       font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Cancel
          </button>
          <button
            type="button" onClick={handleSave} disabled={saving || !reason.trim()}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-accent-strong px-5 text-base
                       font-bold text-white hover:bg-sky-500 disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
