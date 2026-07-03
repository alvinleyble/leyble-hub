import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import DangerZoneDelete from '../../components/ui/DangerZoneDelete';
import Combobox from '../../components/ui/Combobox';
import { productMatches } from '../../utils/productSearch';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const ORDER_STATUS = {
  pending:    { label: 'Pending',    color: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_transit: { label: 'In Transit', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  completed:  { label: 'Delivered',  color: 'bg-green-100 text-green-800 border-green-300' },
  done:       { label: 'Closed',     color: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled:  { label: 'Cancelled',  color: 'bg-red-100 text-red-700 border-red-300' },
};

const TYPE_BADGE = {
  regular:    'bg-slate-100 text-slate-600 border-slate-200',
  wholesaler: 'bg-amber-100 text-amber-800 border-amber-300',
};

const DEFAULT_PRICE_FORM = {
  product_id: '', custom_unit_price: '', notes: '',
};

export default function CustomerDetailPanel({ customerId, onClose, onSaved }) {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [customer, setCustomer]     = useState(null);
  const [orders, setOrders]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [form, setForm]             = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving]         = useState(false);

  const [customPrices, setCustomPrices]     = useState([]);
  const [priceTab, setPriceTab]             = useState('delivery');
  const [products, setProducts]             = useState([]);
  const [pricingOpen, setPricingOpen]       = useState(false);
  const [priceForm, setPriceForm]           = useState(DEFAULT_PRICE_FORM);
  const [priceErrors, setPriceErrors]       = useState({});
  const [priceSaving, setPriceSaving]       = useState(false);

  const loadCustomPrices = useCallback(async (orderType = priceTab) => {
    const prices = await api.get(`/customers/${customerId}/prices?order_type=${orderType}`).catch(() => []);
    setCustomPrices(prices);
  }, [customerId, priceTab]);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/customers/${customerId}`)
      .then(async (data) => {
        setCustomer(data);
        setOrders(data.orders ?? []);
        setForm({
          name:          data.name,
          customer_type: data.customer_type,
          phone:         data.phone ?? '',
          address:       data.address ?? '',
          notes:         data.notes ?? '',
          is_active:     data.is_active,
        });
        if (data.customer_type === 'wholesaler') {
          const prices = await api.get(`/customers/${customerId}/prices?order_type=${priceTab}`).catch(() => []);
          setCustomPrices(prices);
        } else {
          setCustomPrices([]);
        }
      })
      .catch(() => addToast('Failed to load customer.', 'error'))
      .finally(() => setLoading(false));
  }, [customerId, addToast, priceTab]);

  useEffect(() => { load(); }, [load]);

  const set = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim()) errs.name = 'Required.';
    if (Object.keys(errs).length) { setFormErrors(errs); return; }

    setSaving(true);
    try {
      await api.patch(`/customers/${customerId}`, {
        name:          form.name.trim(),
        customer_type: form.customer_type,
        phone:         form.phone.trim() || null,
        address:       form.address.trim() || null,
        notes:         form.notes.trim() || null,
        is_active:     form.is_active,
      });
      addToast('Customer updated.', 'success');
      onSaved();
      load();
    } catch (err) {
      addToast(err.message || 'Failed to update customer.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openPricingForm = async () => {
    if (products.length === 0) {
      try {
        const prods = await api.get('/products');
        setProducts(prods);
      } catch {
        addToast('Failed to load products.', 'error');
        return;
      }
    }
    setPricingOpen(true);
  };

  const selectPriceProduct = (product) => {
    setPriceForm((f) => ({
      ...f,
      product_id:         String(product.id),
      custom_unit_price:  String(product.base_wholesale_price),
    }));
  };

  const setP = (field) => (e) => setPriceForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSetPrice = async () => {
    const errs = {};
    if (!priceForm.product_id) errs.product_id = 'Select a product.';
    if (priceForm.custom_unit_price === '') errs.custom_unit_price = 'Enter a price.';
    if (Object.keys(errs).length) { setPriceErrors(errs); return; }

    setPriceSaving(true);
    try {
      await api.post(`/customers/${customerId}/prices`, {
        product_id:        Number(priceForm.product_id),
        custom_unit_price: Number(priceForm.custom_unit_price),
        notes:             priceForm.notes.trim() || null,
        order_type:        priceTab,
      });
      addToast('Custom price set.', 'success');
      setPricingOpen(false);
      setPriceForm(DEFAULT_PRICE_FORM);
      setPriceErrors({});
      const updated = await api.get(`/customers/${customerId}/prices?order_type=${priceTab}`);
      setCustomPrices(updated);
    } catch (err) {
      addToast(err.message || 'Failed to set price.', 'error');
    } finally {
      setPriceSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed top-0 right-0 z-50 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col"
        role="dialog" aria-modal="true" aria-labelledby="customer-detail-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="customer-detail-title" className="text-xl font-bold text-slate-900 truncate pr-4">
            {loading ? 'Loading…' : customer?.name}
          </h2>
          <button
            onClick={onClose} aria-label="Close panel"
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
          <div className="flex-1 overflow-y-auto">

            {/* ── Summary bar ──────────────────────────────────── */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center gap-3 flex-wrap">
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${TYPE_BADGE[customer.customer_type]}`}>
                {customer.customer_type === 'wholesaler' ? 'Wholesalers' : 'Regular Customer'}
              </span>
              {!customer.is_active && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-red-100 text-red-700 border border-red-300">
                  Inactive
                </span>
              )}
              <span className="text-sm text-slate-400 ml-auto">
                {orders.length} order{orders.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* ── Edit form ─────────────────────────────────────── */}
            <form onSubmit={handleSave} noValidate>
              <div className="px-6 py-5 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                  <FormField label="Customer Name" required error={formErrors.name} className="sm:col-span-2">
                    <input type="text" value={form.name} onChange={set('name')} className={INPUT} />
                  </FormField>

                  <FormField label="Customer Type" required className="sm:col-span-2">
                    <select value={form.customer_type} onChange={set('customer_type')} className={INPUT}>
                      <option value="regular">Regular Customer — Without Custom Prices</option>
                      <option value="wholesaler">Wholesalers — With Custom Prices</option>
                    </select>
                  </FormField>

                  <FormField label="Phone" hint="Optional">
                    <input type="tel" value={form.phone} onChange={set('phone')}
                      className={INPUT} placeholder="09XX XXX XXXX" />
                  </FormField>

                  <FormField label="Address" hint="Optional">
                    <input type="text" value={form.address} onChange={set('address')} className={INPUT} />
                  </FormField>

                  <FormField label="Notes" hint="Optional" className="sm:col-span-2">
                    <textarea value={form.notes} onChange={set('notes')} rows={3}
                      className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                                 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none" />
                  </FormField>

                  <div className="sm:col-span-2 flex items-center gap-3 min-h-[48px]">
                    <input type="checkbox" id="cust_active" checked={form.is_active}
                      onChange={set('is_active')} className="w-6 h-6 accent-blue-700" />
                    <label htmlFor="cust_active" className="text-base font-medium text-slate-700 cursor-pointer">
                      Active
                    </label>
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 flex justify-end border-b border-slate-200">
                <Button type="submit" loading={saving}>Save Changes</Button>
              </div>
            </form>

            {/* ── Wholesaler Custom Pricing ────────────────────── */}
            {customer.customer_type === 'wholesaler' && (
              <div className="px-6 py-5 border-b border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Wholesaler Custom Prices</p>
                  {!pricingOpen && (
                    <Button size="sm" variant="secondary" onClick={openPricingForm}>
                      + Set Price
                    </Button>
                  )}
                </div>

                {/* Delivery / Pickup tab switcher */}
                <div className="flex gap-1.5 mb-4">
                  {['delivery', 'pickup'].map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setPriceTab(type);
                        setPricingOpen(false);
                        api.get(`/customers/${customerId}/prices?order_type=${type}`)
                          .then(setCustomPrices)
                          .catch(() => {});
                      }}
                      className={`px-4 py-1.5 rounded-lg text-sm font-semibold border transition-colors
                        ${priceTab === type
                          ? type === 'delivery'
                            ? 'bg-slate-800 text-white border-slate-800'
                            : 'bg-blue-700 text-white border-blue-700'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                    >
                      {type === 'delivery' ? '🚚 Delivery' : '🏪 Pickup'}
                    </button>
                  ))}
                </div>

                {pricingOpen && (
                  <div className="mb-5 p-4 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="text-sm font-bold text-amber-900 mb-3">
                      Set {priceTab === 'pickup' ? 'Pickup' : 'Delivery'} Price
                    </p>
                    <div className="grid grid-cols-1 gap-3">
                      <FormField label="Product" required error={priceErrors.product_id}>
                        <Combobox
                          items={products.filter((p) => p.is_active)}
                          match={productMatches}
                          onSelect={selectPriceProduct}
                          onQueryChange={() => setPriceForm((f) => ({ ...f, product_id: '' }))}
                          displayValue={(p) => p.sku || p.name}
                          placeholder="Search product…"
                          emptyText="No products match."
                          renderRow={(p) => (
                            <>
                              <span className="font-medium text-slate-800">{p.sku || p.name}</span>
                              <span className="text-sm text-slate-400 shrink-0 tabular-nums">
                                std {PHP(p.base_wholesale_price)}
                              </span>
                            </>
                          )}
                        />
                      </FormField>

                      <FormField label="Custom Price (₱/case)" required error={priceErrors.custom_unit_price}>
                        <input type="number" min="0" step="0.01"
                          value={priceForm.custom_unit_price} onChange={setP('custom_unit_price')}
                          className={INPUT} placeholder="0.00" />
                      </FormField>

                      <FormField label="Notes" hint="Optional">
                        <input type="text" value={priceForm.notes} onChange={setP('notes')}
                          className={INPUT} placeholder="e.g. Special agreement" />
                      </FormField>

                      <div className="flex gap-2 mt-1">
                        <Button variant="secondary" size="sm" disabled={priceSaving}
                          onClick={() => {
                            setPricingOpen(false);
                            setPriceForm(DEFAULT_PRICE_FORM);
                            setPriceErrors({});
                          }}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={handleSetPrice} loading={priceSaving}>
                          Save Price
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {customPrices.length === 0 ? (
                  <p className="text-sm text-slate-400">No custom prices set yet.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
                          <th className="text-left px-4 py-2 font-semibold">Product</th>
                          <th className="text-right px-4 py-2 font-semibold">Price / Case</th>
                          <th className="text-right px-4 py-2 font-semibold hidden sm:table-cell">Set</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customPrices.map((sp) => (
                          <tr key={sp.id} className="border-t border-slate-100">
                            <td className="px-4 py-3 font-medium text-slate-800">
                              {sp.sku || sp.product_name}
                              {sp.notes && (
                                <span className="block text-xs text-slate-400 italic">{sp.notes}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                              {PHP(sp.custom_unit_price)}
                            </td>
                            <td className="px-4 py-3 text-right text-slate-400 text-xs hidden sm:table-cell">
                              {new Date(sp.created_at).toLocaleDateString('en-PH', {
                                month: 'short', day: 'numeric', year: 'numeric',
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── Order history ─────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                Order History ({orders.length})
              </p>
              {orders.length === 0 ? (
                <p className="text-sm text-slate-400">No orders yet.</p>
              ) : (
                <ol className="space-y-3">
                  {orders.map((o) => {
                    const st = ORDER_STATUS[o.status] ?? {
                      label: o.status,
                      color: 'bg-slate-100 text-slate-600 border-slate-200',
                    };
                    return (
                      <li key={o.id}
                        onClick={() => navigate(`/orders/${o.id}`)}
                        onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/orders/${o.id}`); }}
                        role="button"
                        tabIndex={0}
                        className="flex items-start justify-between gap-4 p-3 rounded-lg border border-slate-200 bg-white
                                   cursor-pointer hover:bg-slate-50 transition-colors
                                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                        <div>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${st.color}`}>
                            {st.label}
                          </span>
                          <p className="text-sm text-slate-500 mt-1">
                            {new Date(o.created_at).toLocaleDateString('en-PH', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </p>
                        </div>
                        <p className="font-bold text-slate-900 tabular-nums text-base">
                          {PHP(o.total_amount)}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {/* ── Danger Zone ───────────────────────────────────── */}
            <DangerZoneDelete
              endpoint={`/customers/${customerId}`}
              entityLabel="customer"
              onDeleted={() => { onSaved(); onClose(); }}
            />

          </div>
        )}
      </div>
    </>
  );
}
