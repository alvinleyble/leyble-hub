import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD = `w-full h-11 rounded-lg border border-v2-border bg-v2-bg px-3 text-base text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const LABEL = 'block text-sm font-bold uppercase tracking-wide text-v2-muted mb-1';

const ACTION_TYPE_LABELS = {
  manual_adjustment: 'Manual Adjustment',
  restock:           'Restock',
  price_change:      'Price Change',
  order_fulfillment: 'Order Dispatched',
  order_edit:        'Order Edited',
  order_cancel:      'Order Cancelled',
};

// Slide-over product detail & audit drawer (proposal §3-4, Slice 2). Shows the
// full V1 field set, an "Adjust Stock & Audit" control (required reason — every
// adjustment here is audit-logged) and the "Recent Stock Movements" trail, plus
// the Danger Zone delete. Reuses the same PATCH /products/:id and GET
// /products/:id (audit_log) endpoints V1's ProductDetailPanel already uses.
export default function ProductDetailDrawer({ productId, onClose, onSaved }) {
  const { addToast } = useToast();

  const [product, setProduct]   = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);

  const [form, setForm]         = useState(null);
  const [formErrors, setFormErrors] = useState({});

  // Stock adjustment
  const [adjMode, setAdjMode]     = useState(false); // false | 'add' | 'subtract' | 'set'
  const [adjQty, setAdjQty]       = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjErrors, setAdjErrors] = useState({});
  const [adjSaving, setAdjSaving] = useState(false);

  // Danger zone
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/products/${productId}`)
      .then((data) => {
        setProduct(data);
        setAuditLog(data.audit_log ?? []);
        setForm({
          name:                 data.name,
          category:             data.category ?? '',
          unit:                 data.unit,
          sku:                  data.sku ?? '',
          base_wholesale_price: String(data.base_wholesale_price),
          deposit_fee:          String(data.deposit_fee),
          units_per_case:       String(data.units_per_case ?? 1),
          current_stock:        String(data.current_stock),
          is_active:            data.is_active,
          requires_bottle_return: data.requires_bottle_return ?? false,
        });
      })
      .catch(() => addToast('Failed to load product.', 'error'))
      .finally(() => setLoading(false));
  }, [productId, addToast]);

  useEffect(() => { load(); }, [load]);

  const set = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
  };

  const handleSaveDetails = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim())                errs.name = 'Required.';
    if (!form.unit.trim())                errs.unit = 'Required.';
    if (form.base_wholesale_price === '') errs.base_wholesale_price = 'Required.';
    if (Number(form.units_per_case) < 1)  errs.units_per_case = 'Must be at least 1.';
    if (form.current_stock === '' || Number(form.current_stock) < 0) errs.current_stock = 'Must be 0 or more.';
    if (Object.keys(errs).length) { setFormErrors(errs); return; }

    setSaving(true);
    try {
      await api.patch(`/products/${productId}`, {
        name:                 form.name.trim(),
        category:             form.category.trim() || null,
        unit:                 form.unit.trim(),
        sku:                  form.sku.trim() || null,
        base_wholesale_price: Number(form.base_wholesale_price),
        deposit_fee:          form.requires_bottle_return ? Number(form.deposit_fee) : 0,
        units_per_case:       Number(form.units_per_case),
        current_stock:        Number(form.current_stock),
        is_active:            form.is_active,
        requires_bottle_return: form.requires_bottle_return,
      });
      addToast('Product updated.', 'success');
      onSaved();
      load();
    } catch (err) {
      addToast(err.message || 'Failed to update product.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAdjust = async () => {
    const errs = {};
    const qty = Number(adjQty);
    if (!adjMode)                          errs.adjMode = 'Select an adjustment type.';
    if (!adjQty || isNaN(qty) || qty <= 0) errs.adjQty = 'Enter a positive number.';
    if (!adjReason.trim())                 errs.adjReason = 'Reason is required for the audit trail.';
    if (Object.keys(errs).length) { setAdjErrors(errs); return; }

    let newStock;
    if (adjMode === 'add')           newStock = Number(product.current_stock) + qty;
    else if (adjMode === 'subtract') newStock = Math.max(0, Number(product.current_stock) - qty);
    else                              newStock = qty; // 'set'

    setAdjSaving(true);
    try {
      await api.patch(`/products/${productId}`, {
        current_stock: newStock,
        reason:        adjReason.trim(),
      });
      addToast('Stock adjusted.', 'success');
      setAdjMode(false);
      setAdjQty('');
      setAdjReason('');
      setAdjErrors({});
      onSaved();
      load();
    } catch (err) {
      addToast(err.message || 'Failed to adjust stock.', 'error');
    } finally {
      setAdjSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.del(`/products/${productId}`);
      if (result?.outcome === 'deactivated') {
        addToast('This product has history and can’t be permanently deleted, so it was hidden (deactivated) instead.', 'success');
      } else {
        addToast('Product permanently deleted.', 'success');
      }
      onSaved();
      onClose();
    } catch (err) {
      addToast(err.message || 'Failed to delete product.', 'error');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-v2-border
                   bg-v2-surface shadow-2xl"
        role="dialog" aria-modal="true" aria-labelledby="product-detail-title"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <h2 id="product-detail-title" className="truncate pr-4 text-xl font-bold text-v2-text">
            {loading ? 'Loading…' : product?.name}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto">

            {/* ── Stock summary + Adjust Stock & Audit ─────────────────── */}
            <div className="border-b border-v2-border bg-v2-bg px-6 py-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-bold uppercase tracking-wide text-v2-muted">Current Stock</p>
                  <p className={`mt-1 text-5xl font-black tabular-nums ${
                    Number(product.current_stock) <= 0  ? 'text-red-400'  :
                    Number(product.current_stock) <= 10 ? 'text-amber-400' : 'text-v2-text'
                  }`}>
                    {product.current_stock}
                    <span className="ml-2 text-xl font-medium text-v2-muted">{product.unit}</span>
                  </p>
                  {product.units_per_case > 1 && (
                    <p className="mt-1 text-sm text-v2-muted">{product.units_per_case} bottles per case</p>
                  )}
                </div>
                {!adjMode && (
                  <button
                    type="button"
                    onClick={() => setAdjMode('add')}
                    className="flex min-h-tablet items-center justify-center rounded-xl bg-emerald-600 px-5
                               text-base font-bold text-white hover:bg-emerald-500
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                  >
                    ⚡ Adjust Stock &amp; Audit
                  </button>
                )}
              </div>

              {adjMode && (
                <div className="mt-5 rounded-xl border border-v2-border bg-v2-surface p-4">
                  <p className="mb-3 text-sm font-bold uppercase tracking-wide text-v2-muted">
                    Adjust Stock &amp; Audit
                  </p>

                  <div className="mb-4 flex gap-2">
                    {[
                      { value: 'add',      label: '📦 Add' },
                      { value: 'subtract', label: '⚠ Remove' },
                      { value: 'set',      label: '✏ Set to' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setAdjMode(value)}
                        className={`min-h-[44px] flex-1 rounded-lg border text-sm font-bold transition-colors
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                          ${adjMode === value
                            ? 'border-v2-accent-strong bg-v2-accent-strong text-white'
                            : 'border-v2-border bg-v2-bg text-v2-muted hover:bg-v2-raised'
                          }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="mb-3 grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL} htmlFor="adj-qty">
                        {adjMode === 'set' ? 'New stock count' : 'Cases'}
                      </label>
                      <input
                        id="adj-qty" type="number" min="0" step="0.5" value={adjQty}
                        onChange={(e) => setAdjQty(e.target.value)}
                        className={FIELD}
                      />
                      {adjErrors.adjQty && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{adjErrors.adjQty}</p>}
                    </div>

                    {adjMode !== 'set' && (
                      <div className="flex flex-col justify-end">
                        <span className="mb-1 block text-xs text-v2-muted">Result</span>
                        <div className="rounded-lg border border-v2-border bg-v2-bg px-3 py-2.5 text-sm">
                          <span className="font-bold text-v2-text">
                            {adjMode === 'add'
                              ? Number(product.current_stock) + (Number(adjQty) || 0)
                              : Math.max(0, Number(product.current_stock) - (Number(adjQty) || 0))
                            } {product.unit}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <label className={LABEL} htmlFor="adj-reason">
                    Reason <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="adj-reason" type="text" value={adjReason}
                    onChange={(e) => setAdjReason(e.target.value)}
                    className={FIELD}
                    placeholder="e.g. Delivery from plant, damaged in warehouse…"
                    aria-required="true"
                  />
                  {adjErrors.adjReason && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{adjErrors.adjReason}</p>}
                  {adjErrors.adjMode && <p role="alert" className="mt-2 text-sm font-semibold text-red-400">{adjErrors.adjMode}</p>}

                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setAdjMode(false); setAdjQty(''); setAdjReason(''); setAdjErrors({}); }}
                      disabled={adjSaving}
                      className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                                 font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAdjust}
                      disabled={adjSaving}
                      className="flex min-h-tablet items-center justify-center rounded-xl bg-emerald-600 px-5 text-base
                                 font-bold text-white hover:bg-emerald-500 shadow-sm disabled:opacity-50
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      {adjSaving ? 'Saving…' : 'Apply'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Edit details form ─────────────────────────────── */}
            <form onSubmit={handleSaveDetails} noValidate>
              <div className="border-b border-v2-border px-6 py-5">
                <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">Details</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

                  <div className="sm:col-span-2">
                    <label className={LABEL} htmlFor="pd-name">Product Name *</label>
                    <input id="pd-name" type="text" value={form.name} onChange={set('name')} className={FIELD} />
                    {formErrors.name && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.name}</p>}
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="pd-category">Category</label>
                    <input id="pd-category" type="text" value={form.category} onChange={set('category')} className={FIELD}
                      placeholder="e.g. Beer" />
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="pd-unit">Unit *</label>
                    <input id="pd-unit" type="text" value={form.unit} onChange={set('unit')} className={FIELD} />
                    {formErrors.unit && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.unit}</p>}
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="pd-sku">SKU</label>
                    <input id="pd-sku" type="text" value={form.sku} onChange={set('sku')} className={FIELD} />
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="pd-units-per-case">Bottles per Case *</label>
                    <input id="pd-units-per-case" type="number" min="1" step="1" value={form.units_per_case}
                      onChange={set('units_per_case')} className={FIELD} />
                    {formErrors.units_per_case && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.units_per_case}</p>}
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="pd-stock">Current Stock (cases, 0.5 = half case) *</label>
                    <input id="pd-stock" type="number" min="0" step="0.5" value={form.current_stock}
                      onChange={set('current_stock')} className={FIELD} />
                    {formErrors.current_stock && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.current_stock}</p>}
                  </div>

                  <label className="flex min-h-[48px] cursor-pointer select-none items-center gap-3 sm:col-span-2">
                    <input
                      type="checkbox" checked={form.is_active}
                      onChange={set('is_active')} className="h-6 w-6 accent-v2-accent-strong"
                    />
                    <span className="text-base font-medium text-v2-text">Active (visible when creating orders)</span>
                  </label>
                </div>
              </div>

              <div className="border-b border-v2-border px-6 py-5">
                <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">Pricing (per case)</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={LABEL} htmlFor="pd-price">Wholesale Price (₱) *</label>
                    <input id="pd-price" type="number" min="0" step="0.01" value={form.base_wholesale_price}
                      onChange={set('base_wholesale_price')} className={FIELD} />
                    {formErrors.base_wholesale_price && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.base_wholesale_price}</p>}
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="pd-deposit">Deposit Fee (₱ / bottle)</label>
                    <input id="pd-deposit" type="number" min="0" step="0.01" value={form.deposit_fee}
                      disabled={!form.requires_bottle_return}
                      onChange={set('deposit_fee')}
                      className={`${FIELD} disabled:opacity-40`} />
                  </div>
                </div>
              </div>

              <div className="border-b border-v2-border px-6 py-5">
                <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">Returns</p>
                <label className="flex min-h-[48px] cursor-pointer select-none items-center gap-3">
                  <input
                    type="checkbox" checked={form.requires_bottle_return}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      requires_bottle_return: e.target.checked,
                      deposit_fee: e.target.checked ? f.deposit_fee : '0',
                    }))}
                    className="h-6 w-6 accent-v2-accent-strong"
                  />
                  <span className="text-base text-v2-text">
                    Requires bottle return <span className="font-bold text-amber-300">(w/ dep)</span>
                    <span className="block text-sm text-v2-muted">Off for plastic / non-returnable products</span>
                  </span>
                </label>
              </div>

              <div className="flex justify-end border-b border-v2-border px-6 py-4">
                <button
                  type="submit" disabled={saving}
                  className="flex min-h-tablet items-center justify-center rounded-xl bg-emerald-600 px-6 text-base
                             font-bold text-white hover:bg-emerald-500 shadow-sm disabled:opacity-50
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>

            {/* ── Recent Stock Movements ─────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">
                Recent Stock Movements
              </p>
              {auditLog.length === 0 ? (
                <p className="text-sm text-v2-muted">No stock movements recorded yet.</p>
              ) : (
                <ol className="relative ml-2 space-y-5 border-l border-v2-border">
                  {auditLog.map((entry) => (
                    <li key={entry.id} className="ml-4">
                      <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-v2-surface bg-v2-border" />
                      <p className="text-sm font-semibold text-v2-text">
                        {ACTION_TYPE_LABELS[entry.action_type] ?? entry.action_type}
                      </p>
                      {entry.field_changed === 'current_stock' && (
                        <p className="text-sm text-v2-muted">
                          Stock: <span className="font-mono">{entry.previous_value}</span>
                          {' → '}
                          <span className="font-mono font-semibold text-v2-text">{entry.new_value}</span>
                          {entry.delta !== null && (
                            <span className={`ml-2 font-semibold ${Number(entry.delta) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              ({Number(entry.delta) >= 0 ? '+' : ''}{Number(entry.delta)})
                            </span>
                          )}
                        </p>
                      )}
                      {entry.field_changed && entry.field_changed !== 'current_stock' && (
                        <p className="text-sm capitalize text-v2-muted">
                          {entry.field_changed.replace(/_/g, ' ')}:{' '}
                          <span className="font-mono">{entry.previous_value}</span>
                          {' → '}
                          <span className="font-mono font-semibold text-v2-text">{entry.new_value}</span>
                        </p>
                      )}
                      {entry.reason && (
                        <p className="mt-0.5 text-xs italic text-v2-muted">"{entry.reason}"</p>
                      )}
                      <p className="mt-1 text-xs text-v2-muted">
                        {entry.performed_by_name ?? 'System'}
                        {' · '}
                        {new Date(entry.created_at).toLocaleString('en-PH', {
                          month: 'short', day: 'numeric', year: 'numeric',
                          hour: 'numeric', minute: '2-digit',
                        })}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* ── Danger Zone ───────────────────────────────────── */}
            <div className="border-t border-v2-border px-6 py-5">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-red-400">Danger Zone</p>

              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex min-h-tablet items-center justify-center rounded-xl bg-red-700 px-5 text-base
                             font-bold text-white hover:bg-red-600
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  Delete product
                </button>
              ) : (
                <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-4">
                  <p className="mb-1 text-base font-semibold text-red-200">Delete this product?</p>
                  <p className="mb-4 text-sm text-red-300/80">
                    This can't be undone. If it has order or stock history it will be hidden
                    (deactivated) instead of permanently removed.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                      className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                                 font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="flex min-h-tablet items-center justify-center rounded-xl bg-red-700 px-5 text-base
                                 font-bold text-white hover:bg-red-600 disabled:opacity-50
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}
