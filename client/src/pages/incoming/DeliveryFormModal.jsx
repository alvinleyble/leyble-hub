import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import Stepper from '../../components/ui/Stepper';
import ProductSearchBar from '../../components/ui/ProductSearchBar';

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const today = () => new Date().toISOString().slice(0, 10);

// Local YYYY-MM-DD (matches the date the detail panel displays, regardless of tz).
const toDateInput = (iso) => new Date(iso).toLocaleDateString('en-CA');

// Map a saved delivery item (from the API) back into editable form state.
const itemFromRow = (row) => ({
  _key:              row.id ?? Math.random(),
  product_id:        String(row.product_id),
  product_name:      row.product_name || '',
  sku:               row.sku || '',
  quantity_received: String(Number(row.quantity_received)),
  unit_cost:         row.unit_cost != null ? String(Number(row.unit_cost)) : '',
  notes:             row.notes || '',
});

export default function DeliveryFormModal({ onClose, onSaved, delivery = null }) {
  const { addToast } = useToast();
  const isEdit = !!delivery;

  const [products, setProducts]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  const [supplierName, setSupplierName] = useState(delivery?.supplier_name ?? '');
  const [receivedAt, setReceivedAt]     = useState(delivery ? toDateInput(delivery.received_at) : today());
  const [notes, setNotes]               = useState(delivery?.notes ?? '');
  const [items, setItems]               = useState(
    delivery?.items?.length ? delivery.items.map(itemFromRow) : []
  );
  // _key of a line to briefly highlight after add / qty bump.
  const [flashKey, setFlashKey]         = useState(null);
  const flashTimer                      = useRef(null);
  const [errors, setErrors]             = useState({});

  useEffect(() => {
    api.get('/products')
      .then((prods) => setProducts(prods.filter((p) => p.is_active)))
      .catch(() => addToast('Failed to load products.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const flash = (key) => {
    setFlashKey(key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashKey(null), 1000);
  };

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i._key !== key));

  const updateItem = (key, field, value) =>
    setItems((prev) => prev.map((i) => i._key === key ? { ...i, [field]: value } : i));

  // Tap a product to prepend a line; re-tap bumps its quantity by one case.
  const addProduct = (product) => {
    const item = {
      _key:              Math.random(),
      product_id:        String(product.id),
      product_name:      product.name,
      sku:               product.sku || '',
      quantity_received: '1',
      unit_cost:         '',
      notes:             '',
    };
    setItems((prev) => [item, ...prev]);
    flash(item._key);
  };

  // The + on the search-bar row (tap or hold) adds half a case. Functional update so press-and-
  // hold repeats step correctly off the latest quantity.
  const bumpProduct = (product) => {
    setItems((prev) => prev.map((i) =>
      i.product_id === String(product.id)
        ? { ...i, quantity_received: String(Math.round(((Number(i.quantity_received) || 0) + 0.5) * 10) / 10) }
        : i
    ));
  };

  // The − drops half a case; the line is removed once it reaches 0 (never negative).
  const subProduct = (product) => {
    setItems((prev) => {
      const i = prev.find((x) => x.product_id === String(product.id));
      if (!i) return prev;
      const next = Math.round(((Number(i.quantity_received) || 0) - 0.5) * 10) / 10;
      return next <= 0
        ? prev.filter((x) => x._key !== i._key)
        : prev.map((x) => (x._key === i._key ? { ...x, quantity_received: String(next) } : x));
    });
  };

  const validate = () => {
    const e = {};
    if (!supplierName.trim()) e.supplierName = 'Supplier name is required.';
    if (!receivedAt) e.receivedAt = 'Date received is required.';
    if (items.length === 0) e.items = 'Add at least one product.';
    if (items.some((i) => !Number(i.quantity_received) || Number(i.quantity_received) <= 0))
      e.items = 'All quantities must be greater than 0.';
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    const payload = {
      supplier_name: supplierName.trim(),
      notes:         notes.trim() || null,
      received_at:   receivedAt,
      items: items.map((i) => ({
        product_id:        Number(i.product_id),
        quantity_received: Number(i.quantity_received),
        unit_cost:         i.unit_cost !== '' ? Number(i.unit_cost) : null,
        notes:             i.notes.trim() || null,
      })),
    };
    try {
      if (isEdit) {
        await api.patch(`/incoming/${delivery.id}`, payload);
        addToast('Delivery updated.', 'success');
      } else {
        await api.post('/incoming', payload);
        addToast('Delivery logged.', 'success');
      }
      onSaved();
    } catch (err) {
      addToast(err.message || `Failed to ${isEdit ? 'update' : 'log'} delivery.`, 'error');
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
            {isEdit ? 'Edit Delivery' : 'Log Delivery'}
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
                  {items.length > 0 && (
                    <p className="text-sm text-slate-500">
                      {items.length} {items.length === 1 ? 'product' : 'products'}
                    </p>
                  )}
                </div>

                <ProductSearchBar
                  products={products}
                  quantityFor={(p) => {
                    const it = items.find((i) => i.product_id === String(p.id));
                    return it ? Number(it.quantity_received) || 0 : 0;
                  }}
                  onAdd={addProduct}
                  onBump={bumpProduct}
                  onSub={subProduct}
                />

                {errors.items && (
                  <p className="text-sm text-red-600 mt-3">{errors.items}</p>
                )}

                {items.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400 text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    Search above and tap products to add them to this delivery.
                  </p>
                ) : (
                  <div className="space-y-3 mt-4">
                    {items.map((item) => (
                      <div
                        key={item._key}
                        className={`p-3 rounded-lg border transition-colors
                          ${flashKey === item._key ? 'bg-blue-50 border-blue-300' : 'bg-slate-50 border-slate-200'}`}
                      >
                        {/* Line 1: product + remove */}
                        <div className="flex items-center gap-2 mb-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-slate-800 truncate" title={item.product_name}>
                              {item.sku || item.product_name}
                            </p>
                            {item.sku && (
                              <p className="text-xs text-slate-500 truncate">{item.product_name}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => removeItem(item._key)}
                            aria-label={`Remove ${item.sku || item.product_name}`}
                            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                                       hover:text-red-600 hover:bg-red-50 shrink-0"
                          >
                            ✕
                          </button>
                        </div>

                        {/* Line 2: qty + unit cost */}
                        <div className="grid grid-cols-2 gap-2">
                          <FormField label="Qty Received (cases)">
                            <Stepper
                              value={item.quantity_received}
                              onChange={(v) => updateItem(item._key, 'quantity_received', v)}
                              step={0.5}
                              min={0.5}
                              label={`Quantity received in cases for ${item.sku || item.product_name}`}
                            />
                          </FormField>
                          <FormField label="Unit Cost / case (₱)" hint="Optional">
                            <input
                              type="number" min="0" step="0.01"
                              value={item.unit_cost}
                              onChange={(e) => updateItem(item._key, 'unit_cost', e.target.value)}
                              className={INPUT}
                              placeholder="optional"
                            />
                          </FormField>
                        </div>

                        {/* Line 3: item notes */}
                        <div className="mt-2">
                          <input
                            type="text"
                            value={item.notes}
                            onChange={(e) => updateItem(item._key, 'notes', e.target.value)}
                            className={INPUT}
                            placeholder="Item notes (optional)…"
                            aria-label={`Notes for ${item.sku || item.product_name}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200 shrink-0 bg-white">
              <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={handleSubmit} loading={saving}>{isEdit ? 'Save Changes' : 'Log Delivery'}</Button>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
