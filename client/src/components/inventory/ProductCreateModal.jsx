import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';

const FIELD = `w-full h-12 rounded-lg border border-v2-border bg-v2-bg px-4 text-base text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const LABEL = 'block text-sm font-bold uppercase tracking-wide text-v2-muted mb-1';

const DEFAULT_FORM = {
  name: '', category: '', unit: 'case', sku: '',
  base_wholesale_price: '', deposit_fee: '0',
  current_stock: '0', units_per_case: '1',
  requires_bottle_return: false,
};

// V2 dark-themed Add Product modal — same fields/validation as V1's
// ProductFormModal, restyled for the tablet shell.
export default function ProductCreateModal({ onClose, onSaved }) {
  const { addToast } = useToast();
  const [form, setForm]     = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.name.trim())               e.name = 'Product name is required.';
    if (!form.unit.trim())               e.unit = 'Unit is required.';
    if (form.base_wholesale_price === '') e.base_wholesale_price = 'Wholesale price is required.';
    if (Number(form.units_per_case) < 1) e.units_per_case = 'Must be at least 1.';
    if (Number(form.current_stock) < 0)  e.current_stock = 'Stock cannot be negative.';
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      await api.post('/products', {
        name:                 form.name.trim(),
        category:             form.category.trim() || null,
        unit:                 form.unit.trim(),
        sku:                  form.sku.trim() || null,
        base_wholesale_price: Number(form.base_wholesale_price),
        deposit_fee:          form.requires_bottle_return ? Number(form.deposit_fee) : 0,
        current_stock:        Number(form.current_stock),
        units_per_case:       Number(form.units_per_case),
        requires_bottle_return: form.requires_bottle_return,
      });
      addToast(`${form.name} added to inventory.`, 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to create product.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog" aria-modal="true" aria-labelledby="create-product-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-8 flex w-full max-w-lg flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <h2 id="create-product-title" className="text-xl font-bold text-v2-text">Add Product</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-5 px-6 py-5 sm:grid-cols-2">

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="cp-name">Product Name *</label>
              <input id="cp-name" type="text" value={form.name} onChange={set('name')}
                className={FIELD} placeholder="e.g. Coke 1.5L" />
              {errors.name && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.name}</p>}
            </div>

            <div>
              <label className={LABEL} htmlFor="cp-category">Category</label>
              <input id="cp-category" type="text" value={form.category} onChange={set('category')}
                className={FIELD} placeholder="e.g. Soft Drinks" />
            </div>

            <div>
              <label className={LABEL} htmlFor="cp-unit">Unit *</label>
              <input id="cp-unit" type="text" value={form.unit} onChange={set('unit')}
                className={FIELD} placeholder="case" />
              {errors.unit && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.unit}</p>}
            </div>

            <div>
              <label className={LABEL} htmlFor="cp-sku">SKU</label>
              <input id="cp-sku" type="text" value={form.sku} onChange={set('sku')}
                className={FIELD} placeholder="e.g. CC-15L" />
            </div>

            <div>
              <label className={LABEL} htmlFor="cp-units-per-case">Bottles per Case *</label>
              <input id="cp-units-per-case" type="number" min="1" step="1" value={form.units_per_case}
                onChange={set('units_per_case')} className={FIELD} />
              {errors.units_per_case && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.units_per_case}</p>}
            </div>

            <div>
              <label className={LABEL} htmlFor="cp-stock">Initial Stock (cases)</label>
              <input id="cp-stock" type="number" min="0" step="0.5" value={form.current_stock}
                onChange={set('current_stock')} className={FIELD} />
              {errors.current_stock && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.current_stock}</p>}
            </div>

            <div className="border-t border-v2-border pt-4 sm:col-span-2">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">Pricing (per case)</p>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="cp-price">Wholesale Price (₱ / case) *</label>
                  <input id="cp-price" type="number" min="0" step="0.01" value={form.base_wholesale_price}
                    onChange={set('base_wholesale_price')} className={FIELD} placeholder="0.00" />
                  {errors.base_wholesale_price && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.base_wholesale_price}</p>}
                </div>
                <div>
                  <label className={LABEL} htmlFor="cp-deposit">Deposit Fee (₱ / bottle)</label>
                  <input id="cp-deposit" type="number" min="0" step="0.01" value={form.deposit_fee}
                    disabled={!form.requires_bottle_return}
                    onChange={set('deposit_fee')}
                    className={`${FIELD} disabled:opacity-40`} placeholder="0.00" />
                </div>
              </div>
            </div>

            <div className="border-t border-v2-border pt-4 sm:col-span-2">
              <label className="flex min-h-tablet cursor-pointer select-none items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.requires_bottle_return}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    requires_bottle_return: e.target.checked,
                    deposit_fee: e.target.checked ? f.deposit_fee : '0',
                  }))}
                  className="h-6 w-6 accent-v2-accent-strong"
                />
                <span className="text-base text-v2-text">
                  Requires bottle return
                  <span className="block text-sm text-v2-muted">Off for plastic / non-returnable products</span>
                </span>
              </label>
            </div>

          </div>
        </form>

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
            type="button" onClick={handleSubmit} disabled={saving}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-accent-strong px-5 text-base
                       font-bold text-white hover:bg-v2-accent disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            {saving ? 'Saving…' : 'Save Product'}
          </button>
        </div>
      </div>
    </div>
  );
}
