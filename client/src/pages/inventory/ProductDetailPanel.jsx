import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import Stepper from '../../components/ui/Stepper';
import DangerZoneDelete from '../../components/ui/DangerZoneDelete';
import OfflineBanner from '../../components/ui/OfflineBanner';
import { getCachedEntity } from '../../offline/catalogue.js';
import { updateProductLocalFirst, pendingProductEditIds } from '../../offline/productMutations.js';
import { subscribeOutbox } from '../../offline/outbox.js';
import { STOCK_FIELD, PRICE_FIELD } from '../../offline/reconcile.js';
import { checkIsOnline } from '../../offline/status.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const ACTION_TYPE_LABELS = {
  manual_adjustment: 'Manual Adjustment',
  restock:           'Restock',
  price_change:      'Price Change',
  order_fulfillment: 'Order Dispatched',
  order_edit:        'Order Edited',
  order_cancel:      'Order Cancelled',
  delivery_edit:     'Delivery Edited',
};

export default function ProductDetailPanel({ productId, onClose, onSaved, cachedProduct = null }) {
  const { addToast } = useToast();

  const [product, setProduct]       = useState(null);
  const [auditLog, setAuditLog]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  const [form, setForm]             = useState(null);
  const [formErrors, setFormErrors] = useState({});

  // Stock adjustment
  const [adjMode, setAdjMode]       = useState(false);
  const [adjQty, setAdjQty]         = useState('');
  const [adjReason, setAdjReason]   = useState('');
  const [adjErrors, setAdjErrors]   = useState({});
  const [adjSaving, setAdjSaving]   = useState(false);
  const [fromCache, setFromCache]   = useState(false);
  const [pendingSync, setPendingSync] = useState(false);

  const hydrate = (data) => {
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
  };

  // ADR 0015 §6 — the panel renders from the held catalogue copy when the line is
  // down, so stock can still be counted and corrected blind. The audit log is the one
  // part that genuinely needs the server (it lives only there, append-only), so it
  // simply shows as unavailable rather than blocking the rest of the panel.
  const load = useCallback(() => {
    setLoading(true);
    api.get(`/products/${productId}`)
      .then((data) => { hydrate(data); setFromCache(false); })
      .catch(async () => {
        const held = cachedProduct
          || (await getCachedEntity('products')).find((p) => String(p.id) === String(productId));
        if (!held) { addToast('Failed to load product.', 'error'); return; }
        hydrate({ ...held, audit_log: [] });
        setFromCache(true);
      })
      .finally(() => setLoading(false));
  }, [productId, addToast, cachedProduct]);

  useEffect(() => { load(); }, [load]);

  // Criteria 7.5's sync-status affordance, panel side: an edit saved blind writes
  // straight onto the held copy, so this panel re-renders showing the operator's own
  // number with nothing to say it has not left the tablet yet. Read it from the outbox
  // rather than from the save's return value, so re-opening the panel later says the
  // same thing, and so the badge clears itself the moment the record drains.
  const refreshPendingSync = useCallback(async () => {
    const ids = await pendingProductEditIds();
    setPendingSync(ids.has(String(productId)));
  }, [productId]);

  useEffect(() => {
    refreshPendingSync();
    return subscribeOutbox(() => refreshPendingSync());
  }, [refreshPendingSync]);

  // Criteria 7.3 / 7.4 (bottle return, bottles per case) and the captain's 2026-08-29
  // clarification extending 8.5 / 9.2's active-toggle rule to products. Everything
  // else on this panel — name, category, SKU, price, stock — still saves blind.
  const mutationsBlocked = fromCache || !checkIsOnline();
  const blockedTip = mutationsBlocked ? 'Needs a connection' : undefined;

  const set = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
  };

  const handleSaveDetails = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim())               errs.name = 'Required.';
    if (!form.unit.trim())               errs.unit = 'Required.';
    if (form.base_wholesale_price === '') errs.base_wholesale_price = 'Required.';
    if (Number(form.units_per_case) < 1) errs.units_per_case = 'Must be at least 1.';
    if (form.current_stock === '' || Number(form.current_stock) < 0) errs.current_stock = 'Must be 0 or more.';
    if (Object.keys(errs).length) { setFormErrors(errs); return; }

    setSaving(true);
    try {
      const profileKey = await api.getActiveProfile();
      const patch = {
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
      };
      // The three locked controls are disabled above, so these carry the values the
      // product already had — but a PATCH that restates them would still overwrite a
      // change another tablet made while this one was blind, on exactly the fields that
      // have no reconciliation path. The visible disable is the UX contract; leaving
      // them out of the body is what makes it true on the wire.
      if (mutationsBlocked) {
        delete patch.units_per_case;
        delete patch.requires_bottle_return;
        delete patch.deposit_fee;
        delete patch.is_active;
      }
      const { synced } = await updateProductLocalFirst(productId, patch, {
        profileKey,
        product,
        // Only these two can be contested by another tablet counting or repricing the
        // same product; the rest of the form is master data nobody else is racing on.
        guardFields: [STOCK_FIELD, PRICE_FIELD],
      });
      addToast(
        synced ? 'Product updated.' : 'Saved on this device \u00b7 will sync when connected.',
        'success'
      );
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
    if (!adjMode)                         errs.adjMode = 'Select an adjustment type.';
    if (!adjQty || isNaN(qty) || qty <= 0) errs.adjQty = 'Enter a positive number.';
    if (Object.keys(errs).length) { setAdjErrors(errs); return; }

    let newStock;
    if (adjMode === 'add')           newStock = Number(product.current_stock) + qty;
    else if (adjMode === 'subtract') newStock = Math.max(0, Number(product.current_stock) - qty);
    else                             newStock = qty; // 'set'

    setAdjSaving(true);
    try {
      // ADR 0015 §6 supersedes ADR 0005 §2: a physical count correction is exactly the
      // thing that happens during an outage, so it queues instead of being blocked. If
      // another tablet corrected the same count in the meantime, the drain lifts this
      // out into a reconciliation question rather than overwriting theirs.
      const profileKey = await api.getActiveProfile();
      const reason = adjReason.trim() || null;
      const { synced } = await updateProductLocalFirst(productId, {
        current_stock: newStock,
        reason,
      }, { profileKey, product, guardFields: [STOCK_FIELD], reason });
      addToast(
        synced ? 'Stock adjusted.' : 'Stock count saved on this device \u00b7 will sync when connected.',
        'success'
      );
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

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed top-0 right-0 z-50 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col"
        role="dialog" aria-modal="true" aria-labelledby="product-detail-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <h2 id="product-detail-title" className="text-xl font-bold text-slate-900 truncate pr-4">
            {loading ? 'Loading…' : (product?.name ?? 'Product')}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : !product ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <p className="text-base font-medium text-slate-500">Product details not available offline.</p>
            <Button variant="secondary" className="mt-4" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">

            {fromCache && (
              <div className="px-6 pt-5">
                <OfflineBanner
                  className="mb-0"
                  message="Viewing offline data · Stock counts and prices you change here sync when connected"
                />
              </div>
            )}

            {pendingSync && (
              <div className="px-6 pt-5">
                <div
                  role="status"
                  className="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3"
                >
                  <span className="text-xl leading-none shrink-0" aria-hidden="true">⏳</span>
                  <p className="text-sm font-semibold text-amber-900">
                    Waiting to sync — changes saved on this tablet have not reached the other
                    devices yet.
                  </p>
                </div>
              </div>
            )}

            {/* ── Stock summary ─────────────────────────────────── */}
            <div className="px-6 py-5 bg-slate-50 border-b border-slate-400">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Current Stock</p>
                  <p className={`text-5xl font-bold tabular-nums mt-1 ${
                    Number(product.current_stock ?? 0) <= 0 ? 'text-red-600' :
                    Number(product.current_stock ?? 0) <= 10 ? 'text-amber-600' : 'text-slate-900'
                  }`}>
                    {product.current_stock != null ? product.current_stock : '—'}
                    <span className="text-xl font-medium text-slate-400 ml-2">{product.unit || ''}</span>
                  </p>
                  {Number(product.units_per_case || 1) > 1 && (
                    <p className="text-sm text-slate-400 mt-1">
                      {product.units_per_case} bottles per case
                    </p>
                  )}
                </div>
                {!adjMode && (
                  <Button variant="secondary" onClick={() => setAdjMode('add')}>
                    Adjust Stock
                  </Button>
                )}
              </div>

              {/* ── Stock adjustment form ──────────────────────── */}
              {adjMode && (
                <div className="mt-5 p-4 bg-white rounded-lg border border-slate-200">
                  <p className="text-sm font-bold text-slate-700 mb-3">Adjust Stock</p>

                  <div className="flex gap-2 mb-4">
                    {[
                      { value: 'add',      label: '+ Add' },
                      { value: 'subtract', label: '− Remove' },
                      { value: 'set',      label: '= Set to' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setAdjMode(value)}
                        className={`flex-1 min-h-[44px] rounded-lg border text-sm font-semibold transition-colors
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                          ${adjMode === value
                            ? 'bg-blue-700 text-white border-blue-700'
                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                          }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FormField
                      label={adjMode === 'set' ? 'New stock count' : 'Cases'}
                      error={adjErrors.adjQty}
                    >
                      <Stepper
                        value={adjQty}
                        onChange={setAdjQty}
                        step={0.5}
                        min={0.5}
                        label={adjMode === 'set' ? 'New stock count' : 'Cases'}
                      />
                    </FormField>

                    {adjMode !== 'set' && (
                      <div className="flex items-end">
                        <div className="px-3 py-2 bg-slate-50 rounded-lg border border-slate-200 text-sm text-slate-500 w-full">
                          <span className="block text-xs text-slate-400 mb-0.5">Result</span>
                          <span className="font-bold text-slate-800">
                            {adjMode === 'add'
                              ? Number(product?.current_stock ?? 0) + (Number(adjQty) || 0)
                              : Math.max(0, Number(product?.current_stock ?? 0) - (Number(adjQty) || 0))
                            } {product?.unit || ''}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <FormField label="Reason" hint="Optional — describe why stock is being changed">
                    <input
                      type="text" value={adjReason}
                      onChange={(e) => setAdjReason(e.target.value)}
                      className={INPUT}
                      placeholder="e.g. Physical count correction"
                    />
                  </FormField>

                  {adjErrors.adjMode && (
                    <p className="text-sm text-red-600 mt-2">{adjErrors.adjMode}</p>
                  )}

                  <div className="flex gap-2 mt-4">
                    <Button
                      variant="secondary" size="sm"
                      onClick={() => { setAdjMode(false); setAdjQty(''); setAdjReason(''); setAdjErrors({}); }}
                      disabled={adjSaving}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleAdjust} loading={adjSaving}>
                      Apply
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Edit details form ─────────────────────────────── */}
            <form onSubmit={handleSaveDetails} noValidate>
              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                  <FormField label="Product Name" required error={formErrors.name} className="sm:col-span-2">
                    <input type="text" value={form.name} onChange={set('name')} className={INPUT} />
                  </FormField>

                  <FormField label="Category">
                    <input type="text" value={form.category} onChange={set('category')} className={INPUT}
                      placeholder="e.g. Beer" />
                  </FormField>

                  <FormField label="Unit" required error={formErrors.unit}>
                    <input type="text" value={form.unit} onChange={set('unit')} className={INPUT} />
                  </FormField>

                  <FormField label="SKU" hint="Optional">
                    <input type="text" value={form.sku} onChange={set('sku')} className={INPUT} />
                  </FormField>

                  <FormField label="Bottles per Case" required error={formErrors.units_per_case}
                    hint={mutationsBlocked ? 'Needs a connection' : undefined}>
                    <input type="number" min="1" step="1" value={form.units_per_case}
                      onChange={set('units_per_case')}
                      disabled={mutationsBlocked} title={blockedTip}
                      className={INPUT + ' disabled:bg-slate-100 disabled:text-slate-400'} />
                  </FormField>

                  <FormField label="Current Stock" required error={formErrors.current_stock}
                    hint={`Cases — 0.5 = half case`}>
                    <input type="number" min="0" step="0.5" value={form.current_stock}
                      onChange={set('current_stock')} className={INPUT} />
                  </FormField>

                  <div className="sm:col-span-2 min-h-[48px]" title={blockedTip}>
                    <div className="flex items-center gap-3 min-h-[48px]">
                      <input
                        type="checkbox" id="is_active" checked={form.is_active}
                        onChange={set('is_active')} disabled={mutationsBlocked}
                        className="w-6 h-6 accent-blue-700 disabled:opacity-50"
                      />
                      <label
                        htmlFor="is_active"
                        className={`text-base font-medium ${mutationsBlocked
                          ? 'text-slate-400 cursor-not-allowed' : 'text-slate-700 cursor-pointer'}`}
                      >
                        Active (visible when creating orders)
                      </label>
                    </div>
                    {mutationsBlocked && (
                      <p className="text-sm text-slate-500">
                        Hiding or restoring a product needs a connection — it decides what every
                        other tablet can sell right now.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Pricing (per case)</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Wholesale Price (₱)" required error={formErrors.base_wholesale_price}>
                    <input type="number" min="0" step="0.01" value={form.base_wholesale_price}
                      onChange={set('base_wholesale_price')} className={INPUT} />
                  </FormField>
                  <FormField label="Deposit Fee (₱ / bottle)"
                    hint={mutationsBlocked ? 'Needs a connection' : 'Only for returnable-bottle products'}>
                    <input type="number" min="0" step="0.01" value={form.deposit_fee}
                      disabled={mutationsBlocked || !form.requires_bottle_return}
                      onChange={set('deposit_fee')} title={blockedTip}
                      className={INPUT + ' disabled:bg-slate-100 disabled:text-slate-400'} />
                  </FormField>
                </div>
              </div>

              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Returns</p>
                <label
                  className={`flex items-center gap-3 min-h-[48px] select-none
                              ${mutationsBlocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  title={blockedTip}
                >
                  <input
                    type="checkbox" id="requires_bottle_return" checked={form.requires_bottle_return}
                    disabled={mutationsBlocked}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      requires_bottle_return: e.target.checked,
                      deposit_fee: e.target.checked ? f.deposit_fee : '0',
                    }))}
                    className="w-6 h-6 accent-blue-700 disabled:opacity-50"
                  />
                  <span className={`text-base ${mutationsBlocked ? 'text-slate-400' : 'text-slate-700'}`}>
                    Requires bottle return
                    <span className="block text-sm text-slate-400">Off for plastic / non-returnable products</span>
                  </span>
                </label>
                {mutationsBlocked && (
                  <p className="text-sm text-slate-500 mt-2">
                    Bottle return and its deposit need a connection — turning them on or off
                    changes what every past and future order line owes.
                  </p>
                )}
              </div>

              <div className="px-6 py-4 flex justify-end border-b border-slate-400">
                <Button type="submit" loading={saving}>Save Changes</Button>
              </div>
            </form>

            {/* ── Audit log ─────────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                Audit Log (last 50)
              </p>
              {(auditLog || []).length === 0 ? (
                <p className="text-slate-400 text-sm">
                  {fromCache
                    ? 'The audit log lives on the server — it needs a connection to read.'
                    : 'No audit entries yet.'}
                </p>
              ) : (
                <ol className="relative border-l border-slate-400 ml-2 space-y-5">
                  {(auditLog || []).map((entry) => (
                    <li key={entry.id} className="ml-4">
                      <div className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-slate-300 border-2 border-white" />
                      <p className="text-sm font-semibold text-slate-700">
                        {ACTION_TYPE_LABELS[entry.action_type] ?? entry.action_type}
                      </p>
                      {entry.field_changed === 'current_stock' && (
                        <p className="text-sm text-slate-500">
                          Stock: <span className="font-mono">{entry.previous_value}</span>
                          {' → '}
                          <span className="font-mono font-semibold">{entry.new_value}</span>
                          {entry.delta !== null && (
                            <span className={`ml-2 font-semibold ${Number(entry.delta) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              ({Number(entry.delta) >= 0 ? '+' : ''}{Number(entry.delta)})
                            </span>
                          )}
                        </p>
                      )}
                      {entry.field_changed && entry.field_changed !== 'current_stock' && (
                        <p className="text-sm text-slate-500 capitalize">
                          {entry.field_changed.replace(/_/g, ' ')}:{' '}
                          <span className="font-mono">{entry.previous_value}</span>
                          {' → '}
                          <span className="font-mono font-semibold">{entry.new_value}</span>
                        </p>
                      )}
                      {entry.reason && (
                        <p className="text-xs text-slate-400 mt-0.5 italic">"{entry.reason}"</p>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
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
            {/* Captain decision, Slice 3.3: product DELETE stays online-only, the same
                treatment customer merges (§7) and delivery voids (§8) get. Stock counts
                and prices have a reconciliation path because two tablets can each hold
                a valid number; "deleted" and "mid-sale on it" have no such middle
                value, so §6's full-CRUD grant deliberately stops short of this one. */}
            <DangerZoneDelete
              endpoint={`/products/${productId}`}
              entityLabel="product"
              onDeleted={() => { onSaved(); onClose(); }}
              disabled={mutationsBlocked}
              disabledReason="Deleting a product needs a connection — another tablet could be selling it right now."
            />

          </div>
        )}
      </div>
    </>
  );
}
