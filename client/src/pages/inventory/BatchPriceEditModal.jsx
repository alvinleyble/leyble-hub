import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import { batchPriceLocalFirst } from '../../offline/productMutations.js';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const round2 = (n) => Math.round(n * 100) / 100;

// Resolves a uniform adjustment (percent/fixed/set) against one product's current
// price. The adjustment direction depends on the sign of adjValue: positive increases,
// negative decreases. Negative results are clamped to 0 but flagged as clamped
// so the preview can call it out instead of silently changing what the owner typed.
export function computeUniformPrice(current, adjType, adjValue) {
  const val = Number(adjValue) || 0;
  let next;
  if (adjType === 'set') {
    next = val;
  } else if (adjType === 'percent') {
    const delta = current * (val / 100);
    next = current + delta;
  } else {
    next = current + val;
  }
  return { clamped: Math.max(0, round2(next)), wasClamped: next < 0 };
}

const ADJ_TYPES = [
  { value: 'percent', label: 'Percent (%)' },
  { value: 'fixed',   label: 'Fixed (₱)' },
  { value: 'set',     label: 'Set to (₱)' },
];

function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map(({ value: v, label }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`flex-1 min-h-[44px] rounded-lg border text-sm font-semibold transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
            ${value === v
              ? 'bg-blue-700 text-white border-blue-700'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function BatchPriceEditModal({ products, onClose, onSaved }) {
  const { addToast } = useToast();

  const [mode, setMode]             = useState('uniform'); // 'uniform' | 'individual'
  const [adjType, setAdjType]       = useState('fixed');    // 'percent' | 'fixed' | 'set'
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

    const { clamped, wasClamped } = computeUniformPrice(current, adjType, adjValue);
    return { product, current, next: clamped, wasClamped, invalid: false };
  });

  const handleSave = async () => {
    setSubmitError('');

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
      // ADR 0015 §6 supersedes ADR 0005 §2 — a batch reprice goes through the outbox
      // like everything else. One record, but one guard check per product: a price
      // another tablet already changed is lifted out into a reconciliation question
      // and the other 40 still land, rather than the whole batch waiting on one row.
      const profileKey = await api.getActiveProfile();
      const { synced } = await batchPriceLocalFirst(updates, reason.trim() || null, {
        profileKey, products,
      });
      addToast(
        synced
          ? `${updates.length} product price${updates.length === 1 ? '' : 's'} updated.`
          : `${updates.length} price${updates.length === 1 ? '' : 's'} saved on this device \u00b7 will sync when connected.`,
        'success'
      );
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to update prices.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/50 overflow-y-auto"
      role="dialog" aria-modal="true" aria-labelledby="batch-price-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl flex flex-col my-8 max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <h2 id="batch-price-title" className="text-xl font-bold text-slate-900">
            Batch Edit Prices ({products.length} product{products.length === 1 ? '' : 's'})
          </h2>
          <button
            onClick={onClose} aria-label="Close" disabled={saving}
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1">
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
            <div className="mb-5 p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div className="mb-3">
                <span className="text-sm font-semibold text-slate-700 mb-1.5 block">Adjustment type</span>
                <SegmentedControl options={ADJ_TYPES} value={adjType} onChange={setAdjType} />
              </div>

              <FormField
                label={adjType === 'percent' ? 'Percent' : adjType === 'set' ? 'New price (₱)' : 'Amount (₱)'}
              >
                <input
                  type="number"
                  min={adjType === 'set' ? '0' : undefined}
                  step="0.01"
                  value={adjValue}
                  onChange={(e) => setAdjValue(e.target.value)}
                  className={INPUT}
                  placeholder={
                    adjType === 'percent'
                      ? 'e.g. 5 or -5'
                      : adjType === 'set'
                      ? 'e.g. 2.00'
                      : 'e.g. 2.00 or -2.00'
                  }
                />
              </FormField>
            </div>
          )}

          {/* Preview / individual entry table */}
          <div className="border border-slate-200 rounded-lg overflow-hidden mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 uppercase tracking-wider text-xs border-b border-slate-400">
                  <th className="text-left px-4 py-2 font-semibold">Product</th>
                  <th className="text-left px-4 py-2 font-semibold hidden sm:table-cell">SKU</th>
                  <th className="text-right px-4 py-2 font-semibold">Current</th>
                  <th className="text-right px-4 py-2 font-semibold">New Price</th>
                  <th className="text-right px-4 py-2 font-semibold">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ product, current, next, wasClamped, invalid }) => {
                  const delta = invalid ? null : round2(next - current);
                  return (
                    <tr key={product.id} className="border-t border-slate-300">
                      <td className="px-4 py-3 font-medium text-slate-900">{product.name}</td>
                      <td className="px-4 py-3 text-slate-500 font-mono hidden sm:table-cell">{product.sku ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-500 tabular-nums">{PHP(current)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {mode === 'individual' ? (
                          <input
                            type="number" min="0" step="0.01"
                            value={individualPrices[product.id] ?? ''}
                            onChange={setIndividualPrice(product.id)}
                            aria-label={`New price for ${product.name}`}
                            aria-invalid={invalid || undefined}
                            className="w-28 h-11 px-3 border border-slate-300 rounded-lg text-right text-base text-slate-900
                                       focus:outline-none focus:ring-2 focus:ring-blue-600"
                          />
                        ) : (
                          <span className="font-semibold text-slate-900">{PHP(next)}</span>
                        )}
                        {wasClamped && (
                          <p className="text-xs text-amber-600 font-semibold mt-0.5">Clamped to ₱0.00</p>
                        )}
                        {invalid && (
                          <p className="text-xs text-red-600 font-semibold mt-0.5">Enter a price</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {invalid ? (
                          <span className="text-slate-400">—</span>
                        ) : delta === 0 ? (
                          <span className="font-semibold text-slate-400">No change</span>
                        ) : (
                          <span className={`font-semibold ${delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
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

          <FormField label="Reason" hint="Optional — applied to every product's audit log entry">
            <input
              type="text" value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={INPUT}
              placeholder="e.g. Supplier price increase Q3"
            />
          </FormField>

          {submitError && (
            <p role="alert" className="text-sm text-red-600 font-semibold mt-3">{submitError}</p>
          )}
        </div>

        <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-400 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Save Changes</Button>
        </div>
      </div>
    </div>
  );
}
