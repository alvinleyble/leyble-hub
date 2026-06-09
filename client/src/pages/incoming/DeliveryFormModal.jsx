import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const INPUT_SM = `w-full h-10 px-3 border border-slate-300 rounded-lg text-sm text-slate-900
                  focus:outline-none focus:ring-2 focus:ring-blue-600`;

const today = () => new Date().toISOString().slice(0, 10);

const newItem = () => ({
  _key:              Math.random(),
  _productSearch:    '',
  product_id:        '',
  quantity_received: '',
  unit_cost:         '',
  notes:             '',
});

export default function DeliveryFormModal({ onClose, onSaved }) {
  const { addToast } = useToast();

  const [products, setProducts]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  const [supplierName, setSupplierName] = useState('');
  const [receivedAt, setReceivedAt]     = useState(today());
  const [notes, setNotes]               = useState('');
  const [items, setItems]               = useState([newItem()]);
  const [openDropKey, setOpenDropKey]   = useState(null);
  const [errors, setErrors]             = useState({});

  useEffect(() => {
    api.get('/products')
      .then((prods) => setProducts(prods.filter((p) => p.is_active)))
      .catch(() => addToast('Failed to load products.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const addItem = () => setItems((prev) => [...prev, newItem()]);

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i._key !== key));

  const updateItem = (key, field, value) =>
    setItems((prev) => prev.map((i) => i._key === key ? { ...i, [field]: value } : i));

  const selectProduct = (key, product) => {
    const display = product.name + (product.category ? ` (${product.category})` : '');
    setItems((prev) => prev.map((i) => i._key === key
      ? { ...i, _productSearch: display, product_id: String(product.id) }
      : i
    ));
    setOpenDropKey(null);
  };

  const validate = () => {
    const e = {};
    if (!supplierName.trim()) e.supplierName = 'Supplier name is required.';
    if (!receivedAt) e.receivedAt = 'Date received is required.';
    if (items.some((i) => !i.product_id)) e.items = 'All items must have a product selected.';
    if (items.some((i) => !Number(i.quantity_received) || Number(i.quantity_received) <= 0))
      e.items = 'All quantities must be greater than 0.';
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      await api.post('/incoming', {
        supplier_name: supplierName.trim(),
        notes:         notes.trim() || null,
        received_at:   receivedAt,
        items: items.map((i) => ({
          product_id:        Number(i.product_id),
          quantity_received: Number(i.quantity_received),
          unit_cost:         i.unit_cost !== '' ? Number(i.unit_cost) : null,
          notes:             i.notes.trim() || null,
        })),
      });
      addToast('Delivery logged.', 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to log delivery.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="delivery-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white w-full sm:rounded-xl sm:max-w-2xl h-[95vh] sm:h-auto sm:max-h-[95vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="delivery-modal-title" className="text-xl font-bold text-slate-900">
            Log Delivery
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">

              {/* ── Delivery header fields ───────────────────────────── */}
              <div className="px-6 py-5 border-b border-slate-200 space-y-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Delivery Info</p>

                <FormField label="Supplier Name" error={errors.supplierName}>
                  <input
                    type="text"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    className={INPUT}
                    placeholder="e.g. Coca-Cola, San Miguel Corp…"
                    autoFocus
                  />
                </FormField>

                <FormField label="Date Received" error={errors.receivedAt}>
                  <input
                    type="date"
                    value={receivedAt}
                    onChange={(e) => setReceivedAt(e.target.value)}
                    className={INPUT}
                  />
                </FormField>

                <FormField label="Notes" hint="Optional">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                               focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                    placeholder="Any additional notes…"
                  />
                </FormField>
              </div>

              {/* ── Line items ──────────────────────────────────────── */}
              <div className="px-6 py-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Products Received</p>
                  <Button size="sm" variant="secondary" onClick={addItem}>+ Add Product</Button>
                </div>

                {errors.items && (
                  <p className="text-sm text-red-600 mb-3">{errors.items}</p>
                )}

                <div className="space-y-3">
                  {items.map((item, idx) => (
                    <div key={item._key} className="p-3 bg-slate-50 rounded-lg border border-slate-200">

                      {/* Product combobox */}
                      <div className="flex items-start gap-2 mb-2">
                        <div className="relative flex-1">
                          <input
                            type="text"
                            value={item._productSearch}
                            onChange={(e) => {
                              setItems((prev) => prev.map((i) =>
                                i._key === item._key
                                  ? { ...i, _productSearch: e.target.value, product_id: '' }
                                  : i
                              ));
                              setOpenDropKey(item._key);
                            }}
                            onFocus={() => setOpenDropKey(item._key)}
                            onBlur={() => setTimeout(() => setOpenDropKey(null), 150)}
                            className={INPUT_SM}
                            placeholder="Search product…"
                            aria-label={`Product ${idx + 1}`}
                            autoComplete="off"
                          />
                          {openDropKey === item._key && (
                            <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                              {products
                                .filter((p) =>
                                  p.name.toLowerCase().includes((item._productSearch || '').toLowerCase()) ||
                                  (p.category ?? '').toLowerCase().includes((item._productSearch || '').toLowerCase())
                                )
                                .map((p) => (
                                  <li key={p.id}>
                                    <button
                                      type="button"
                                      onMouseDown={() => selectProduct(item._key, p)}
                                      className="w-full text-left px-4 py-3 text-sm min-h-[48px] hover:bg-blue-50 flex items-center justify-between gap-2"
                                    >
                                      <span className="font-medium text-slate-800">{p.name}</span>
                                      {p.category && (
                                        <span className="text-sm text-slate-400 shrink-0">{p.category}</span>
                                      )}
                                    </button>
                                  </li>
                                ))}
                              {products.filter((p) =>
                                p.name.toLowerCase().includes((item._productSearch || '').toLowerCase()) ||
                                (p.category ?? '').toLowerCase().includes((item._productSearch || '').toLowerCase())
                              ).length === 0 && (
                                <li className="px-4 py-3 text-sm text-slate-400">No products match.</li>
                              )}
                            </ul>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeItem(item._key)}
                          disabled={items.length === 1}
                          aria-label="Remove item"
                          className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                                     hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ✕
                        </button>
                      </div>

                      {/* Qty + Unit Cost */}
                      <div className="grid grid-cols-2 gap-2">
                        <FormField label="Qty Received (cases)">
                          <input
                            type="number" min="0.5" step="0.5"
                            value={item.quantity_received}
                            onChange={(e) => updateItem(item._key, 'quantity_received', e.target.value)}
                            className={INPUT_SM}
                            placeholder="0"
                          />
                        </FormField>
                        <FormField label="Unit Cost / case (₱)" hint="Optional">
                          <input
                            type="number" min="0" step="0.01"
                            value={item.unit_cost}
                            onChange={(e) => updateItem(item._key, 'unit_cost', e.target.value)}
                            className={INPUT_SM}
                            placeholder="optional"
                          />
                        </FormField>
                      </div>

                      {/* Item notes */}
                      <div className="mt-2">
                        <input
                          type="text"
                          value={item.notes}
                          onChange={(e) => updateItem(item._key, 'notes', e.target.value)}
                          className={INPUT_SM}
                          placeholder="Item notes (optional)…"
                          aria-label={`Item ${idx + 1} notes`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200 shrink-0 bg-white">
              <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={handleSubmit} loading={saving}>Log Delivery</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
