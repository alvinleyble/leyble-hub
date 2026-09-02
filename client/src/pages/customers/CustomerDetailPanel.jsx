import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import DangerZoneDelete from '../../components/ui/DangerZoneDelete';
import Combobox from '../../components/ui/Combobox';
import CustomerMergeModal from '../../components/customers/CustomerMergeModal';
import { productMatches } from '../../utils/productSearch';
import { CUSTOMER_TYPE_OPTIONS, customerTypeBadge, customerTypeLabel, normalizeCustomerType } from '../../utils/customerTypes';
import OfflineBanner from '../../components/ui/OfflineBanner';
import { getCachedEntity } from '../../offline/catalogue.js';
import { updateCustomerLocalFirst } from '../../offline/queuedCustomers.js';
import { checkIsOnline } from '../../offline/status.js';

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
  // The values `form` was seeded with at load time — the snapshot a save's diff is
  // computed against, so a full-form resend never restates a field the operator never
  // touched (item 4, offline-multi-device clobber audit).
  const [snapshot, setSnapshot]     = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving]         = useState(false);
  const [mergeOpen, setMergeOpen]   = useState(false);
  const [fromCache, setFromCache]   = useState(false);

  const [customPrices, setCustomPrices]     = useState([]);
  const [priceTab, setPriceTab]             = useState('delivery');
  const priceTabRef                         = useRef(priceTab);
  useEffect(() => { priceTabRef.current = priceTab; }, [priceTab]);

  const [products, setProducts]             = useState([]);
  const [pricingOpen, setPricingOpen]       = useState(false);
  const [priceForm, setPriceForm]           = useState(DEFAULT_PRICE_FORM);
  const [priceErrors, setPriceErrors]       = useState({});
  const [priceSaving, setPriceSaving]       = useState(false);

  const loadCustomPrices = useCallback(async (orderType = priceTabRef.current) => {
    try {
      const prices = await api.get(`/customers/${customerId}/prices?order_type=${orderType}`);
      setCustomPrices(Array.isArray(prices) ? prices : []);
    } catch {
      setCustomPrices([]);
    }
  }, [customerId]);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    return api.get(`/customers/${customerId}`)
      .then(async (data) => {
        setCustomer(data);
        setOrders(data.orders ?? []);
        {
          const seeded = {
            name:          data.name,
            customer_type: normalizeCustomerType(data.customer_type),
            phone:         data.phone ?? '',
            address:       data.address ?? '',
            notes:         data.notes ?? '',
            is_active:     data.is_active,
          };
          setForm(seeded);
          setSnapshot(seeded);
        }
        // ADR 0009 — saved prices are the pricing source, so every customer has a
        // Custom Prices panel. Nothing is hidden behind the descriptive tag.
        await loadCustomPrices(priceTabRef.current);
      })
      .catch(async () => {
        // ADR 0015 §7 — the directory this device already holds answers "what's her
        // address" during an outage. Order history and saved prices still need the
        // server; the profile itself does not.
        const held = (await getCachedEntity('customers'))
          .find((c) => String(c.id) === String(customerId));
        if (!held) { addToast('Failed to load customer.', 'error'); return; }
        setCustomer(held);
        setOrders([]);
        setFromCache(true);
        {
          const seeded = {
            name:          held.name,
            customer_type: normalizeCustomerType(held.customer_type),
            phone:         held.phone ?? '',
            address:       held.address ?? '',
            notes:         held.notes ?? '',
            is_active:     held.is_active,
          };
          setForm(seeded);
          setSnapshot(seeded);
        }
        await loadCustomPrices(priceTabRef.current);
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [customerId, loadCustomPrices, addToast]);

  // §7 — profile edits queue; merges and deletions never do. A merge re-parents order
  // history, unpaid bottle balances and audit rows irreversibly, and a concurrent one
  // across two blind devices cannot be untangled afterwards.
  const sharedMutationsBlocked = fromCache || !checkIsOnline();

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
      const profileKey = await api.getActiveProfile();
      const finalValues = {
        name:          form.name.trim(),
        customer_type: form.customer_type,
        phone:         form.phone.trim() || null,
        address:       form.address.trim() || null,
        notes:         form.notes.trim() || null,
        is_active:     form.is_active,
      };
      // Diff against the snapshot this form was seeded with, not the field's current
      // server value — only what the operator actually changed belongs on the wire.
      // A full-form resend of every field, changed or not, is what let a blind save on
      // one tablet silently revert a field another tablet had already changed while this
      // one's cached snapshot went stale (item 4, offline-multi-device clobber audit).
      // `snapshot` mirrors `form`'s '' fallback for optional fields, so normalize it the
      // same way `finalValues` normalizes an untouched field to null before comparing.
      const baseline = {
        name:          snapshot.name,
        customer_type: snapshot.customer_type,
        phone:         snapshot.phone || null,
        address:       snapshot.address || null,
        notes:         snapshot.notes || null,
        is_active:     snapshot.is_active,
      };
      const patch = {};
      for (const field of ['name', 'customer_type', 'phone', 'address', 'notes']) {
        if (finalValues[field] !== baseline[field]) patch[field] = finalValues[field];
      }
      // 8.5 — the toggle is disabled offline (below), so this would only ever restate
      // the value already stored; the diff above already drops it when untouched, but
      // this is what keeps it off the wire even offline where a cached snapshot itself
      // may be stale. Leaving it out of the body is what stops a blind save from
      // reversing a deactivation another tablet just made.
      if (!sharedMutationsBlocked && finalValues.is_active !== baseline.is_active) {
        patch.is_active = finalValues.is_active;
      }
      const { synced } = await updateCustomerLocalFirst(customerId, patch, { profileKey });
      addToast(
        synced ? 'Customer updated.' : 'Saved on this device \u00b7 will sync when connected.',
        'success'
      );
      onSaved?.();
      await load(true);
    } catch (err) {
      addToast(err.message || 'Failed to update customer.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openPricingForm = async () => {
    if (sharedMutationsBlocked) return;
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
    if (sharedMutationsBlocked) return;
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
      await loadCustomPrices(priceTab);
      onSaved?.();
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
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <h2 id="customer-detail-title" className="text-xl font-bold text-slate-900 truncate pr-4">
            {loading ? 'Loading…' : (customer?.name ?? 'Customer')}
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
        ) : !customer ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <p className="text-base font-medium text-slate-500">Customer details not available offline.</p>
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
                  message="Viewing offline data · Contact details you change here sync when connected"
                />
              </div>
            )}

            {/* ── Summary bar ──────────────────────────────────── */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-400 flex items-center gap-3 flex-wrap">
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${customerTypeBadge(customer?.customer_type)}`}>
                {customerTypeLabel(customer?.customer_type)}
              </span>
              {customer?.is_active === false && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-red-100 text-red-700 border border-red-300">
                  Inactive
                </span>
              )}
              <span className="text-sm text-slate-400 ml-auto">
                {(orders || []).length} order{(orders || []).length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* ── Edit form ─────────────────────────────────────── */}
            <form onSubmit={handleSave} noValidate>
              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                  <FormField label="Customer Name" required error={formErrors.name} className="sm:col-span-2">
                    <input type="text" value={form.name} onChange={set('name')} className={INPUT} />
                  </FormField>

                  <FormField label="Customer Type" required className="sm:col-span-2">
                    <select value={form.customer_type} onChange={set('customer_type')} className={INPUT}>
                      {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
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

                  {/* 8.5 — everything else on this form still saves blind; only the
                      active flag waits, because it decides what every other tablet can
                      sell to and there is no second value to reconcile. */}
                  <div className="sm:col-span-2 min-h-[48px]" title={sharedMutationsBlocked ? 'Needs a connection' : undefined}>
                    <div className="flex items-center gap-3 min-h-[48px]">
                      <input type="checkbox" id="cust_active" checked={form.is_active}
                        onChange={set('is_active')} disabled={sharedMutationsBlocked}
                        className="w-6 h-6 accent-blue-700 disabled:opacity-50" />
                      <label
                        htmlFor="cust_active"
                        className={`text-base font-medium ${sharedMutationsBlocked
                          ? 'text-slate-400 cursor-not-allowed' : 'text-slate-700 cursor-pointer'}`}
                      >
                        Active
                      </label>
                    </div>
                    {sharedMutationsBlocked && (
                      <p className="text-sm text-slate-500">
                        Deactivating or restoring a customer needs a connection — the rest of
                        this form still saves offline.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 flex justify-end border-b border-slate-400">
                <Button type="submit" loading={saving}>Save Changes</Button>
              </div>
            </form>

            {/* ── Custom Pricing ────────────────────────────────── */}
            <div className="px-6 py-5 border-b border-slate-400">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Custom Prices</p>
                {!pricingOpen && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={openPricingForm}
                    disabled={sharedMutationsBlocked}
                    title={sharedMutationsBlocked ? 'Needs a connection' : undefined}
                  >
                    + Set Price
                  </Button>
                )}
              </div>
              {sharedMutationsBlocked && (
                <p className="text-sm text-slate-500 mb-4">
                  Setting a custom price needs a connection — two offline tablets could
                  otherwise save different prices for the same product with no way to tell
                  which one wins.
                </p>
              )}

              {/* Delivery / Pickup tab switcher */}
              <div className="flex gap-1.5 mb-4">
                {['delivery', 'pickup'].map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setPriceTab(type);
                      setPricingOpen(false);
                      loadCustomPrices(type);
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
                      <Button size="sm" onClick={handleSetPrice} loading={priceSaving}
                        disabled={sharedMutationsBlocked}>
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
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-400">
                        <th className="text-left px-4 py-2 font-semibold">Product</th>
                        <th className="text-right px-4 py-2 font-semibold">Price / Case</th>
                        <th className="text-right px-4 py-2 font-semibold hidden sm:table-cell">Set</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customPrices.map((sp) => (
                        <tr key={sp.id} className="border-t border-slate-300">
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

            {/* ── Order history ─────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                Order History ({(orders || []).length})
              </p>
              {(orders || []).length === 0 ? (
                <p className="text-sm text-slate-400">No orders yet.</p>
              ) : (
                <ol className="space-y-3">
                  {(orders || []).map((o) => {
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

            {/* ── Merge Customer (Housekeeping) ─────────────────── */}
            <div className="px-6 py-5 border-t border-slate-400">
              <p className="text-xs font-bold text-amber-600 uppercase tracking-widest mb-3">Merge & Housekeeping</p>
              <Button
                variant="secondary"
                onClick={() => setMergeOpen(true)}
                className="border-amber-400 text-amber-800 hover:bg-amber-50"
                disabled={sharedMutationsBlocked}
                title={sharedMutationsBlocked ? 'Needs a connection' : undefined}
              >
                🔀 Merge customer
              </Button>
              {sharedMutationsBlocked && (
                <p className="text-sm text-slate-500 mt-2">
                  Merging re-parents order history and bottle balances permanently, so it needs a connection.
                </p>
              )}
            </div>

            {/* ── Danger Zone ───────────────────────────────────── */}
            <DangerZoneDelete
              endpoint={`/customers/${customerId}`}
              entityLabel="customer"
              onDeleted={() => { onSaved(); onClose(); }}
              disabled={sharedMutationsBlocked}
              disabledReason="Deleting a customer needs a connection — it touches order history every device shares."
            />

          </div>
        )}
      </div>

      {mergeOpen && customer && (
        <CustomerMergeModal
          customer={customer}
          orderCount={(orders || []).length}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false);
            onClose();
            onSaved?.();
          }}
        />
      )}
    </>
  );
}
