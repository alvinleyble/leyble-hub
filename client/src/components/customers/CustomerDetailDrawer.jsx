import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import { productMatches } from '../../utils/productSearch';
import OrderViewModal from '../pos/OrderViewModal';
import POSConfirm from '../pos/POSConfirm';
import { usePrintReceipt } from '../../pages/orders/usePrintReceipt';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD = `w-full h-11 rounded-lg border border-v2-border bg-v2-bg px-3 text-base text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const LABEL = 'block text-sm font-bold uppercase tracking-wide text-v2-muted mb-1';

const ORDER_STATUS = {
  pending:    { label: 'Created',     color: 'border-blue-500/30 bg-blue-500/10 text-blue-300' },
  in_transit: { label: 'In Transit',  color: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  completed:  { label: 'Delivered',   color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  done:       { label: 'Closed',      color: 'border-v2-border bg-v2-raised text-v2-muted' },
  cancelled:  { label: 'Cancelled',   color: 'border-red-500/30 bg-red-950/40 text-red-400' },
};

const DEFAULT_PRICE_FORM = {
  product_id: '',
  custom_unit_price: '',
  notes: '',
};

// Dark-themed product combobox for setting custom prices in the customer drawer.
function DarkProductPicker({ products, selectedProductId, onSelect }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const blurTimer = useRef(null);

  const selectedProduct = products.find((p) => String(p.id) === String(selectedProductId)) || null;

  const matches = useMemo(() => {
    return products.filter((p) => productMatches(p, query)).slice(0, 50);
  }, [products, query]);

  const closeSoon = () => {
    blurTimer.current = setTimeout(() => setOpen(false), 150);
  };
  const cancelClose = () => {
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
  };

  const pick = (product) => {
    onSelect(product);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative">
      {selectedProduct ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-v2-border bg-v2-bg px-3 py-2">
          <div className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-v2-text">
              {selectedProduct.sku ? `${selectedProduct.sku} · ` : ''}{selectedProduct.name}
            </span>
            <span className="text-xs text-v2-muted">
              Base Wholesale Price: {PHP(selectedProduct.base_wholesale_price)} / {selectedProduct.unit}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex h-9 items-center rounded-lg bg-v2-raised px-3 text-xs font-bold text-v2-text hover:bg-v2-border
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Change
          </button>
        </div>
      ) : (
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { cancelClose(); setOpen(true); }}
          onBlur={closeSoon}
          placeholder="Search product by name or SKU…"
          className={FIELD}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
      )}

      {open && !selectedProduct && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-v2-border
                     bg-v2-surface shadow-2xl"
        >
          {matches.length === 0 ? (
            <li className="px-4 py-3 text-sm text-v2-muted">No products match.</li>
          ) : (
            matches.map((p) => (
              <li key={p.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(p)}
                  className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm
                             hover:bg-v2-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  <span className="min-w-0 font-medium text-v2-text">
                    {p.sku ? <span className="font-mono text-xs text-v2-muted mr-1.5">{p.sku}</span> : null}
                    {p.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-v2-muted">
                    std {PHP(p.base_wholesale_price)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// Slide-over Customer Detail & Suki Pricing Drawer (proposal §3, Slice 3).
// Exposes 100% of V1 fields, dark slate styling, Delivery vs. Pickup custom pricing
// matrix with live discount math, order history, and delete danger zone.
export default function CustomerDetailDrawer({ customerId, onClose, onSaved }) {
  const { addToast } = useToast();

  const [customer, setCustomer]     = useState(null);
  const [orders, setOrders]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  const [form, setForm]             = useState(null);
  const [formErrors, setFormErrors] = useState({});

  // Wholesaler custom pricing matrix
  const [customPrices, setCustomPrices] = useState([]);
  const [priceTab, setPriceTab]         = useState('delivery'); // 'delivery' | 'pickup'
  const [products, setProducts]         = useState([]);
  const [pricingOpen, setPricingOpen]   = useState(false);
  const [priceForm, setPriceForm]       = useState(DEFAULT_PRICE_FORM);
  const [priceErrors, setPriceErrors]   = useState({});
  const [priceSaving, setPriceSaving]   = useState(false);

  // Order history preview and actions
  const navigate = useNavigate();
  const [previewOrder, setPreviewOrder]   = useState(null);
  const [previewBusyId, setPreviewBusyId] = useState(null);
  const [cancelTarget, setCancelTarget]   = useState(null);
  const [cancelling, setCancelling]       = useState(false);
  const [printOrder, setPrintOrder]       = useState(null);

  const printer = usePrintReceipt(
    printOrder,
    {},
    () => {
      addToast(`Order #${printOrder?.id} receipt sent to printer.`, 'success');
      setPrintOrder(null);
    },
    {},
    { copies: 2, autoTag: true }
  );

  const handleEdit = (order) => {
    setPreviewOrder(null);
    onClose?.();
    navigate('/v2/pos', { state: { editOrder: order } });
  };

  const handleReprint = (order) => {
    setPrintOrder(order);
    printer.handlePrint(order, 2);
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.post(`/orders/${cancelTarget.id}/status`, { status: 'cancelled' });
      addToast(`Order #${cancelTarget.id} cancelled — stock restored.`, 'success');
      setCancelTarget(null);
      setPreviewOrder(null);
      load();
      onSaved?.();
    } catch (err) {
      addToast(err.message || 'Failed to cancel the order.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  // Danger zone
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting]                 = useState(false);

  const loadCustomPrices = useCallback(async (orderType = 'delivery') => {
    try {
      const prices = await api.get(`/customers/${customerId}/prices?order_type=${orderType}`);
      setCustomPrices(prices);
    } catch {
      setCustomPrices([]);
    }
  }, [customerId]);

  const loadProducts = useCallback(async () => {
    try {
      const prods = await api.get('/products');
      const active = (prods || []).filter((p) => p.is_active);
      setProducts(active);
      return active;
    } catch {
      addToast('Failed to load products list.', 'error');
      return [];
    }
  }, [addToast]);

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
          await loadCustomPrices('delivery');
        } else {
          setCustomPrices([]);
        }
      })
      .catch(() => addToast('Failed to load customer details.', 'error'))
      .finally(() => setLoading(false));
  }, [customerId, loadCustomPrices, addToast]);

  useEffect(() => { load(); }, [load]);

  // Preload products for price matrix comparison on mount
  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const handlePreviewOrder = async (orderId) => {
    setPreviewBusyId(orderId);
    try {
      const full = await api.get(`/orders/${orderId}`);
      if (products.length === 0) {
        await loadProducts();
      }
      setPreviewOrder(full);
    } catch (err) {
      addToast(err.message || 'Failed to load order details.', 'error');
    } finally {
      setPreviewBusyId(null);
    }
  };

  const set = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
  };

  const handleSaveDetails = async (e) => {
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

  const openPricingForm = async (presetProduct = null) => {
    await loadProducts();
    if (presetProduct) {
      setPriceForm({
        product_id:        String(presetProduct.id),
        custom_unit_price: String(presetProduct.base_wholesale_price),
        notes:             '',
      });
    } else {
      setPriceForm(DEFAULT_PRICE_FORM);
    }
    setPriceErrors({});
    setPricingOpen(true);
  };

  const editCustomPrice = async (item) => {
    await loadProducts();
    setPriceForm({
      product_id:        String(item.product_id),
      custom_unit_price: String(item.custom_unit_price),
      notes:             item.notes || '',
    });
    setPriceErrors({});
    setPricingOpen(true);
  };

  const selectPriceProduct = (product) => {
    if (!product) {
      setPriceForm((f) => ({ ...f, product_id: '', custom_unit_price: '' }));
      return;
    }
    setPriceForm((f) => ({
      ...f,
      product_id:        String(product.id),
      custom_unit_price: f.custom_unit_price === '' ? String(product.base_wholesale_price) : f.custom_unit_price,
    }));
  };

  const setP = (field) => (e) => setPriceForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSetPrice = async () => {
    const errs = {};
    if (!priceForm.product_id) errs.product_id = 'Select a product.';
    if (priceForm.custom_unit_price === '' || isNaN(Number(priceForm.custom_unit_price)) || Number(priceForm.custom_unit_price) < 0) {
      errs.custom_unit_price = 'Enter a valid non-negative price.';
    }
    if (Object.keys(errs).length) { setPriceErrors(errs); return; }

    setPriceSaving(true);
    try {
      await api.post(`/customers/${customerId}/prices`, {
        product_id:        Number(priceForm.product_id),
        custom_unit_price: Number(priceForm.custom_unit_price),
        notes:             priceForm.notes.trim() || null,
        order_type:        priceTab,
      });
      addToast('Custom price saved.', 'success');
      setPricingOpen(false);
      setPriceForm(DEFAULT_PRICE_FORM);
      setPriceErrors({});
      await loadCustomPrices(priceTab);
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to set custom price.', 'error');
    } finally {
      setPriceSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.del(`/customers/${customerId}`);
      if (result?.outcome === 'deactivated') {
        addToast('Customer has order history and was deactivated (hidden) instead of permanently deleted.', 'success');
      } else {
        addToast('Customer permanently deleted.', 'success');
      }
      onSaved();
      onClose();
    } catch (err) {
      addToast(err.message || 'Failed to delete customer.', 'error');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  // Product map for quick base wholesale price lookup
  const productMap = useMemo(() => {
    const map = {};
    products.forEach((p) => { map[p.id] = p; });
    return map;
  }, [products]);

  // Selected product in price form for live delta math
  const currentSelectedProduct = priceForm.product_id ? productMap[Number(priceForm.product_id)] : null;
  const typedCustomPrice = Number(priceForm.custom_unit_price);
  const baseWholesalePrice = currentSelectedProduct ? Number(currentSelectedProduct.base_wholesale_price) : 0;
  const priceDelta = (currentSelectedProduct && priceForm.custom_unit_price !== '' && !isNaN(typedCustomPrice))
    ? typedCustomPrice - baseWholesalePrice
    : null;
  const deltaPercent = (priceDelta !== null && baseWholesalePrice > 0)
    ? (priceDelta / baseWholesalePrice) * 100
    : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-v2-border
                   bg-v2-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-detail-title"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <h2 id="customer-detail-title" className="truncate pr-4 text-xl font-bold text-v2-text">
            {loading ? 'Loading…' : customer?.name}
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

            {/* ── Summary bar ────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3 border-b border-v2-border bg-v2-bg px-6 py-4">
              {customer.customer_type === 'wholesaler' ? (
                <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-300">
                  Wholesaler (Suki Pricing)
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-v2-border bg-v2-raised px-3 py-1 text-sm font-semibold text-v2-muted">
                  Regular Customer
                </span>
              )}

              {!customer.is_active && (
                <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-950/40 px-3 py-1 text-sm font-semibold text-red-400">
                  Inactive
                </span>
              )}

              <span className="ml-auto text-sm font-medium text-v2-muted">
                {orders.length} order{orders.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* ── Details form ───────────────────────────────────────── */}
            <form onSubmit={handleSaveDetails} noValidate>
              <div className="border-b border-v2-border px-6 py-5">
                <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">Profile Details</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

                  <div className="sm:col-span-2">
                    <label className={LABEL} htmlFor="cust-name">Customer Name *</label>
                    <input
                      id="cust-name"
                      type="text"
                      value={form.name}
                      onChange={set('name')}
                      className={FIELD}
                    />
                    {formErrors.name && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{formErrors.name}</p>}
                  </div>

                  <div className="sm:col-span-2">
                    <label className={LABEL} htmlFor="cust-type">Customer Type *</label>
                    <select
                      id="cust-type"
                      value={form.customer_type}
                      onChange={set('customer_type')}
                      className={FIELD}
                    >
                      <option value="regular">Regular Customer — Without Custom Prices</option>
                      <option value="wholesaler">Wholesalers — With Custom Prices</option>
                    </select>
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="cust-phone">Phone</label>
                    <input
                      id="cust-phone"
                      type="tel"
                      value={form.phone}
                      onChange={set('phone')}
                      className={FIELD}
                      placeholder="09XX XXX XXXX"
                    />
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="cust-address">Address</label>
                    <input
                      id="cust-address"
                      type="text"
                      value={form.address}
                      onChange={set('address')}
                      className={FIELD}
                      placeholder="Street / Barangay"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className={LABEL} htmlFor="cust-notes">Notes</label>
                    <textarea
                      id="cust-notes"
                      value={form.notes}
                      onChange={set('notes')}
                      rows={3}
                      className="w-full rounded-lg border border-v2-border bg-v2-bg px-3 py-2 text-base text-v2-text
                                 placeholder:text-v2-muted focus:outline-none focus-visible:ring-2
                                 focus-visible:ring-v2-accent resize-none"
                      placeholder="Any customer preferences or directions…"
                    />
                  </div>

                  <label className="flex min-h-[48px] cursor-pointer select-none items-center gap-3 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={form.is_active}
                      onChange={set('is_active')}
                      className="h-6 w-6 accent-v2-accent-strong"
                    />
                    <span className="text-base font-medium text-v2-text">Active (visible in POS & order create)</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end border-b border-v2-border px-6 py-4">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex min-h-tablet items-center justify-center rounded-xl bg-emerald-600 px-6 text-base
                             font-bold text-white hover:bg-emerald-500 shadow-sm disabled:opacity-50
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>

            {/* ── Wholesaler Custom Pricing Matrix ───────────────────── */}
            {customer.customer_type === 'wholesaler' && (
              <div className="border-b border-v2-border px-6 py-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-v2-muted">Suki Custom Pricing</p>
                    <p className="text-xs text-v2-muted mt-0.5">Special rates saved per product channel</p>
                  </div>
                  {!pricingOpen && (
                    <button
                      type="button"
                      onClick={() => openPricingForm()}
                      className="flex h-10 items-center gap-1.5 rounded-xl bg-v2-raised px-4 text-sm font-bold text-v2-text
                                 hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      + Set Price
                    </button>
                  )}
                </div>

                {/* Delivery / Pickup tab switcher */}
                <div className="mb-4 flex gap-2" role="tablist" aria-label="Order type price matrix">
                  {['delivery', 'pickup'].map((type) => (
                    <button
                      key={type}
                      type="button"
                      role="tab"
                      aria-selected={priceTab === type}
                      onClick={() => {
                        setPriceTab(type);
                        setPricingOpen(false);
                        loadCustomPrices(type);
                      }}
                      className={`flex min-h-[44px] flex-1 items-center justify-center rounded-xl border text-sm font-bold transition-colors
                                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                        ${priceTab === type
                          ? 'border-v2-accent bg-v2-pill-active text-v2-pill-text shadow-sm'
                          : 'border-v2-border bg-v2-bg text-v2-muted hover:bg-v2-raised hover:text-v2-text'
                        }`}
                    >
                      {type === 'delivery' ? '🚚 Delivery Custom Prices' : '🏪 Pickup Custom Prices'}
                    </button>
                  ))}
                </div>

                {/* Inline Set Price Form */}
                {pricingOpen && (
                  <div className="mb-5 rounded-xl border border-v2-border bg-v2-raised p-4">
                    <p className="mb-3 text-sm font-bold text-v2-text">
                      Set {priceTab === 'pickup' ? 'Pickup' : 'Delivery'} Custom Price
                    </p>

                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className={LABEL}>Product *</label>
                        <DarkProductPicker
                          products={products}
                          selectedProductId={priceForm.product_id}
                          onSelect={selectPriceProduct}
                        />
                        {priceErrors.product_id && <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{priceErrors.product_id}</p>}
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <label className={LABEL} htmlFor="custom-price-input">
                            Custom Price (₱ / case) *
                          </label>
                          {currentSelectedProduct && (
                            <span className="text-xs text-v2-muted tabular-nums">
                              Standard: {PHP(currentSelectedProduct.base_wholesale_price)}
                            </span>
                          )}
                        </div>

                        <input
                          id="custom-price-input"
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={priceForm.custom_unit_price}
                          onChange={setP('custom_unit_price')}
                          className={FIELD}
                          placeholder="0.00"
                        />
                        {priceErrors.custom_unit_price && (
                          <p role="alert" className="mt-1 text-sm font-semibold text-red-400">{priceErrors.custom_unit_price}</p>
                        )}

                        {/* Live discount / delta comparison badge */}
                        {priceDelta !== null && (
                          <div className="mt-2 flex items-center gap-2 rounded-lg border border-v2-border bg-v2-surface px-3 py-2 text-xs">
                            <span className="text-v2-muted">Difference vs Std:</span>
                            {priceDelta < 0 ? (
                              <span className="font-bold text-emerald-400 tabular-nums">
                                -₱{Math.abs(priceDelta).toFixed(2)} ({Math.abs(deltaPercent).toFixed(1)}% discount)
                              </span>
                            ) : priceDelta > 0 ? (
                              <span className="font-bold text-amber-400 tabular-nums">
                                +₱{priceDelta.toFixed(2)} (+{deltaPercent.toFixed(1)}% markup)
                              </span>
                            ) : (
                              <span className="font-medium text-v2-muted">
                                Same as base price
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div>
                        <label className={LABEL} htmlFor="custom-notes-input">Notes (Optional)</label>
                        <input
                          id="custom-notes-input"
                          type="text"
                          value={priceForm.notes}
                          onChange={setP('notes')}
                          className={FIELD}
                          placeholder="e.g. Suki agreement, bulk volume discount"
                        />
                      </div>

                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPricingOpen(false);
                            setPriceForm(DEFAULT_PRICE_FORM);
                            setPriceErrors({});
                          }}
                          disabled={priceSaving}
                          className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                                     font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSetPrice}
                          disabled={priceSaving}
                          className="flex min-h-tablet items-center justify-center rounded-xl bg-emerald-600 px-5 text-base
                                     font-bold text-white hover:bg-emerald-500 shadow-sm disabled:opacity-50
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                        >
                          {priceSaving ? 'Saving…' : 'Save Price'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Custom Prices Matrix Table */}
                {customPrices.length === 0 ? (
                  <p className="py-6 text-center text-sm text-v2-muted">
                    No custom prices set for {priceTab === 'delivery' ? 'delivery' : 'pickup'} orders yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-v2-border bg-v2-bg">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-v2-border bg-v2-surface text-xs uppercase tracking-wider text-v2-muted">
                          <th className="px-3 py-2.5 text-left font-semibold">Product</th>
                          <th className="hidden px-3 py-2.5 text-right font-semibold sm:table-cell">Base Std</th>
                          <th className="px-3 py-2.5 text-right font-semibold">Custom Price</th>
                          <th className="px-3 py-2.5 text-right font-semibold">Savings / Delta</th>
                          <th className="px-3 py-2.5 text-center font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customPrices.map((sp) => {
                          const base = productMap[sp.product_id]?.base_wholesale_price;
                          const custom = Number(sp.custom_unit_price);
                          const delta = base !== undefined ? custom - Number(base) : null;
                          const pct = (delta !== null && Number(base) > 0) ? (delta / Number(base)) * 100 : null;

                          return (
                            <tr key={sp.id} className="border-t border-v2-border transition-colors hover:bg-v2-raised">
                              <td className="px-3 py-3 font-medium text-v2-text">
                                <div>
                                  {sp.sku ? <span className="font-mono text-xs text-v2-muted mr-1">{sp.sku}</span> : null}
                                  {sp.product_name}
                                </div>
                                {sp.notes && (
                                  <span className="block text-xs italic text-v2-muted">{sp.notes}</span>
                                )}
                              </td>
                              <td className="hidden px-3 py-3 text-right tabular-nums text-v2-muted sm:table-cell">
                                {base !== undefined ? PHP(base) : '—'}
                              </td>
                              <td className="px-3 py-3 text-right font-bold tabular-nums text-v2-text">
                                {PHP(sp.custom_unit_price)}
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums">
                                {delta !== null ? (
                                  delta < 0 ? (
                                    <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-bold text-emerald-300">
                                      -₱{Math.abs(delta).toFixed(2)} ({Math.abs(pct).toFixed(1)}%)
                                    </span>
                                  ) : delta > 0 ? (
                                    <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-300">
                                      +₱{delta.toFixed(2)} (+{pct.toFixed(1)}%)
                                    </span>
                                  ) : (
                                    <span className="text-xs text-v2-muted">Std rate</span>
                                  )
                                ) : '—'}
                              </td>
                              <td className="px-3 py-3 text-center">
                                <button
                                  type="button"
                                  onClick={() => editCustomPrice(sp)}
                                  className="rounded-lg border border-v2-border bg-v2-surface px-2.5 py-1 text-xs font-bold text-v2-text
                                             hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                                >
                                  Edit
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── Order history ──────────────────────────────────────── */}
            <div className="border-b border-v2-border px-6 py-5">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-v2-muted">
                Order History ({orders.length})
              </p>
              {orders.length === 0 ? (
                <p className="text-sm text-v2-muted">No past orders recorded yet.</p>
              ) : (
                <ol className="space-y-2.5">
                  {orders.map((o) => {
                    const st = ORDER_STATUS[o.status] ?? {
                      label: o.status,
                      color: 'border-v2-border bg-v2-raised text-v2-muted',
                    };
                    return (
                      <li
                        key={o.id}
                        onClick={() => handlePreviewOrder(o.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handlePreviewOrder(o.id); }}
                        role="button"
                        tabIndex={0}
                        aria-busy={previewBusyId === o.id}
                        className={`flex items-center justify-between gap-4 rounded-xl border border-v2-border bg-v2-bg p-3.5
                                   cursor-pointer transition-colors hover:bg-v2-raised
                                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                                   ${previewBusyId === o.id ? 'opacity-60 cursor-wait' : ''}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-v2-text">Order #{o.id}</span>
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${st.color}`}>
                              {st.label}
                            </span>
                            {previewBusyId === o.id && (
                              <span className="text-xs text-v2-muted">Loading…</span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-v2-muted">
                            {new Date(o.created_at).toLocaleDateString('en-PH', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                            {o.personnel_summary ? ` · ${o.personnel_summary}` : ''}
                          </p>
                        </div>
                        <p className="font-bold tabular-nums text-v2-text text-base">
                          {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {/* ── Danger Zone ────────────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-red-400">Danger Zone</p>

              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex min-h-tablet items-center justify-center rounded-xl bg-red-700 px-5 text-base
                             font-bold text-white hover:bg-red-600
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  Delete customer
                </button>
              ) : (
                <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4">
                  <p className="mb-1 text-base font-semibold text-red-200">Delete this customer?</p>
                  <p className="mb-4 text-sm text-red-300/80">
                    This can't be undone. If they have order history, they will be hidden
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

      {previewOrder && (
        <OrderViewModal
          order={previewOrder}
          products={products}
          busy={cancelling}
          onClose={() => setPreviewOrder(null)}
          onEdit={handleEdit}
          onReprint={handleReprint}
          onCancel={(o) => setCancelTarget(o)}
        />
      )}

      {cancelTarget && (
        <POSConfirm
          title={`Cancel order #${cancelTarget.id}?`}
          zClass="z-[70]"
          confirmLabel="Yes, cancel the order"
          cancelLabel="Keep it"
          danger
          loading={cancelling}
          onConfirm={confirmCancel}
          onClose={() => setCancelTarget(null)}
        >
          This voids the order for <strong className="text-v2-text">{customer?.name || cancelTarget.customer_name}</strong> and
          puts the stock back. It cannot be undone.
        </POSConfirm>
      )}
    </>
  );
}
