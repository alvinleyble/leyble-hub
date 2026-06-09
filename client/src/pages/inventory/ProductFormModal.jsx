import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';

const FIELD_CLASS = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                     focus:outline-none focus:ring-2 focus:ring-blue-600`;

const DEFAULT_FORM = {
  name: '', category: '', unit: 'case', sku: '',
  base_wholesale_price: '', deposit_fee: '0',
  current_stock: '0', units_per_case: '1',
  requires_bottle_return: false,
};

export default function ProductFormModal({ onClose, onSaved }) {
  const { addToast } = useToast();
  const [form, setForm]     = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.name.trim())                  e.name = 'Product name is required.';
    if (!form.unit.trim())                  e.unit = 'Unit is required.';
    if (form.base_wholesale_price === '')   e.base_wholesale_price = 'Wholesale price is required.';
    if (Number(form.units_per_case) < 1)   e.units_per_case = 'Must be at least 1.';
    if (Number(form.current_stock) < 0)    e.current_stock = 'Stock cannot be negative.';
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="create-product-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="create-product-title" className="text-xl font-bold text-slate-900">Add Product</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700
                       hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="overflow-y-auto flex-1">
          <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-5">

            <FormField label="Product Name" required error={errors.name} className="sm:col-span-2">
              <input type="text" value={form.name} onChange={set('name')} className={FIELD_CLASS}
                placeholder="e.g. Coke 1.5L" />
            </FormField>

            <FormField label="Category" error={errors.category}>
              <input type="text" value={form.category} onChange={set('category')} className={FIELD_CLASS}
                placeholder="e.g. Soft Drinks" />
            </FormField>

            <FormField label="Unit" required error={errors.unit} hint="How you count stock (case, pcs…)">
              <input type="text" value={form.unit} onChange={set('unit')} className={FIELD_CLASS}
                placeholder="case" />
            </FormField>

            <FormField label="SKU" error={errors.sku} hint="Optional unique code">
              <input type="text" value={form.sku} onChange={set('sku')} className={FIELD_CLASS}
                placeholder="e.g. CC-15L" />
            </FormField>

            <FormField label="Bottles per Case" required error={errors.units_per_case}
              hint="How many bottles inside one case">
              <input type="number" min="1" step="1" value={form.units_per_case}
                onChange={set('units_per_case')} className={FIELD_CLASS} />
            </FormField>

            <FormField label="Initial Stock" error={errors.current_stock}>
              <input type="number" min="0" step="0.5" value={form.current_stock}
                onChange={set('current_stock')} className={FIELD_CLASS} />
            </FormField>

            <div className="sm:col-span-2 border-t border-slate-100 pt-4">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Pricing (per case)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <FormField label="Wholesale Price (₱ / case)" required error={errors.base_wholesale_price}>
                  <input type="number" min="0" step="0.01" value={form.base_wholesale_price}
                    onChange={set('base_wholesale_price')} className={FIELD_CLASS} placeholder="0.00" />
                </FormField>
                <FormField label="Deposit Fee (₱ / bottle)" hint="Only for returnable-bottle products">
                  <input type="number" min="0" step="0.01" value={form.deposit_fee}
                    disabled={!form.requires_bottle_return}
                    onChange={set('deposit_fee')}
                    className={FIELD_CLASS + ' disabled:bg-slate-100 disabled:text-slate-400'} placeholder="0.00" />
                </FormField>
              </div>
            </div>

            <div className="sm:col-span-2 border-t border-slate-100 pt-4">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Returns</p>
              <label className="flex items-center gap-3 min-h-[48px] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.requires_bottle_return}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    requires_bottle_return: e.target.checked,
                    deposit_fee: e.target.checked ? f.deposit_fee : '0',
                  }))}
                  className="w-6 h-6 accent-blue-700"
                />
                <span className="text-base text-slate-700">
                  Requires bottle return
                  <span className="block text-sm text-slate-400">Off for plastic / non-returnable products</span>
                </span>
              </label>
            </div>

          </div>
        </form>

        {/* Footer */}
        <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>Save Product</Button>
        </div>
      </div>
    </div>
  );
}
