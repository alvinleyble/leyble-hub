import React, { useEffect, useState, useRef, useMemo } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import Combobox from '../../components/ui/Combobox';
import Modal from '../../components/ui/Modal';
import { orderRef } from '../../utils/orderRef';
import { customerTypeBadge, customerTypeLabel, hasCustomPricing } from '../../utils/customerTypes';
import POSProductGrid from '../../components/pos/POSProductGrid';
import CaseStepper from '../../components/pos/CaseStepper';
import { lineTotal, orderTotals, totalCases, roundQty } from '../../components/pos/posMath';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-11 px-3 border border-slate-300 rounded-lg text-sm text-slate-900 bg-white
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const customerMatches = (c, q) => {
  const s = q.trim().toLowerCase();
  return s === '' ? false : c.name.toLowerCase().includes(s);
};

export default function OrderCreateModal({ onClose, onSaved, editOrder = null }) {
  const { addToast } = useToast();
  const isEdit = Boolean(editOrder);

  // Draft modes: a brand-new order and a resumed draft both auto-save as a 'draft' order.
  // A "real edit" (editing a live pending/in_transit/… order) keeps the single-submit flow.
  const isDraftResume = editOrder?.status === 'draft';
  const isRealEdit    = isEdit && !isDraftResume;
  const isDraftMode   = !isRealEdit;

  const [customers, setCustomers]               = useState([]);
  const [products, setProducts]                 = useState([]);
  const [activePersonnel, setActivePersonnel]   = useState([]);
  const [loading, setLoading]                   = useState(true);
  const [saving, setSaving]                     = useState(false);

  const [orderType, setOrderType]               = useState(editOrder?.order_type ?? 'delivery');
  const [customerId, setCustomerId]             = useState(editOrder?.customer_id ? String(editOrder.customer_id) : '');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customPrices, setCustomPrices]         = useState({});
  const [items, setItems]                       = useState(
    editOrder?.items?.map((i) => ({
      _key:                   i.id || Math.random(),
      requires_bottle_return: i.requires_bottle_return ?? false,
      product_id:             String(i.product_id),
      product_name:           i.product_name,
      sku:                    i.sku || '',
      unit:                   i.unit || 'cs',
      quantity:               Number(i.quantity),
      unit_price:             String(i.unit_price),
      unit_deposit_fee:       Number(i.unit_deposit_fee) || 0,
      units_per_case:         Number(i.units_per_case) || 1,
      _priceEdited:           true,
    })) ?? []
  );

  const [assignedPersonnel, setAssignedPersonnel] = useState(
    editOrder?.personnel?.map((p) => ({ id: p.personnel_id, role: p.role })) ?? []
  );
  const [notes, setNotes]                         = useState(editOrder?.notes ?? '');
  const [errors, setErrors]                       = useState({});

  // ── Adjustment ────────────────────────────────────────────────────────────
  const [adjExpanded, setAdjExpanded] = useState(isRealEdit && Number(editOrder?.adjustment) !== 0);
  const [adjValue, setAdjValue]       = useState(isRealEdit && Number(editOrder?.adjustment) ? String(editOrder.adjustment) : '');
  const [adjReason, setAdjReason]     = useState(isRealEdit ? (editOrder?.adjustment_reason ?? '') : '');

  // ── Draft auto-save state ──────────────────────────────────────────────────
  const [draftId, setDraftId]                     = useState(isDraftResume ? editOrder.id : null);
  const [draftStatus, setDraftStatus]             = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingReset, setConfirmingReset]     = useState(false);
  const creatingDraftRef                          = useRef(false);
  // Ref copies for synchronous access in handleSubmit (avoids stale-closure issues with state)
  const draftIdRef         = useRef(isDraftResume ? editOrder.id : null);
  const draftPromiseRef    = useRef(null); // in-flight draft creation promise
  const autoSaveTimerRef   = useRef(null); // handle for the debounced PATCH timer

  // ── Save-custom-price prompt ───────────────────────────────────────────────
  const [priceSavePrompt, setPriceSavePrompt] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/customers'),
      api.get('/products'),
      api.get('/personnel'),
    ])
      .then(([custs, prods, pers]) => {
        setCustomers(custs);
        setProducts(prods);
        setActivePersonnel(pers);
      })
      .catch(() => addToast('Failed to load form data.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCustomer = customers.find((c) => String(c.id) === String(customerId));

  // Load saved prices when customer or order_type changes.
  //
  // ADR 0009: the saved prices ARE the pricing source. Every customer is asked, not
  // just the ones tagged wholesaler/discounted/markup — a customer prices as "custom"
  // exactly when rows come back, so an agreed rate can never be saved and then ignored.
  useEffect(() => {
    if (!customerId) {
      setCustomPrices({});
      return;
    }
    api.get(`/customers/${customerId}/prices?order_type=${orderType}`)
      .then((prices) => {
        const map = {};
        prices.forEach((p) => { map[p.product_id] = p; });
        setCustomPrices(map);
      })
      .catch(() => {});
  }, [customerId, orderType]);

  const activeCustomers = customers.filter((c) => c.is_active);
  const activeProducts  = products.filter((p) => p.is_active);

  // Quick-add a customer straight from the order's customer picker
  const handleCreateCustomer = async (name) => {
    setCreatingCustomer(true);
    try {
      const created = await api.post('/customers', { name, customer_type: 'regular' });
      setCustomers((prev) => [...prev, created]);
      setCustomerId(String(created.id));
      addToast(`${created.name} added as Customer.`, 'success');
    } catch (err) {
      addToast(err.message || 'Failed to create customer.', 'error');
    } finally {
      setCreatingCustomer(false);
    }
  };

  // Resolve the price that applies to a product
  const priceFor = (product) => {
    const customEntry = customPrices[product.id];
    return customEntry ? Number(customEntry.custom_unit_price) : Number(product.base_wholesale_price);
  };

  // Re-price untouched lines when customer's custom prices arrive or orderType changes
  useEffect(() => {
    if (isRealEdit) return;
    setItems((prev) => prev.map((i) => {
      if (i._priceEdited) return i;
      const product = products.find((p) => String(p.id) === i.product_id);
      if (!product) return i;
      const next = String(priceFor(product));
      return next === i.unit_price ? i : { ...i, unit_price: next };
    }));
  }, [customPrices, orderType, products]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map of quantities in order per product id
  const orderQty = useMemo(() => {
    const map = {};
    items.forEach((i) => { map[i.product_id] = (map[i.product_id] || 0) + Number(i.quantity); });
    return map;
  }, [items]);

  // Tapping a product card in the grid adds 0.5 cases (both for new and existing lines)
  const addProduct = (product) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.product_id === String(product.id));
      if (existing) {
        return prev.map((i) =>
          i._key === existing._key
            ? { ...i, quantity: roundQty(Number(i.quantity) + 0.5) }
            : i
        );
      }
      return [
        {
          _key:                   `${product.id}-${Date.now()}`,
          requires_bottle_return: product.requires_bottle_return || false,
          product_id:             String(product.id),
          product_name:           product.name,
          sku:                    product.sku || '',
          unit:                   product.unit || 'cs',
          quantity:               0.5,
          unit_price:             String(priceFor(product)),
          unit_deposit_fee:       product.requires_bottle_return ? Number(product.deposit_fee) : 0,
          units_per_case:         Number(product.units_per_case) || 1,
          _priceEdited:           false,
        },
        ...prev,
      ];
    });
  };

  const stepItem = (key, delta) => {
    setItems((prev) => {
      const item = prev.find((i) => i._key === key);
      if (!item) return prev;
      const next = roundQty(Number(item.quantity) + delta);
      return next <= 0
        ? prev.filter((i) => i._key !== key)
        : prev.map((i) => (i._key === key ? { ...i, quantity: next } : i));
    });
  };

  const updateItemPrice = (key, value) => {
    setItems((prev) => prev.map((i) =>
      i._key === key ? { ...i, unit_price: value, _priceEdited: true } : i
    ));
  };

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i._key !== key));

  // Personnel helpers
  const togglePersonnel = (person) => {
    setAssignedPersonnel((prev) => {
      if (prev.some((p) => p.id === person.id)) {
        return prev.filter((p) => p.id !== person.id);
      }
      const hasDriver = prev.some((p) => p.role === 'Driver');
      return [...prev, { id: person.id, role: hasDriver ? 'Helper' : 'Driver' }];
    });
  };

  const setPersonnelRole = (personId, role) =>
    setAssignedPersonnel((prev) =>
      prev.map((p) => {
        if (p.id === personId) return { ...p, role };
        if (role === 'Driver' && p.role === 'Driver') return { ...p, role: 'Helper' };
        return p;
      })
    );

  // ── Draft auto-save ────────────────────────────────────────────────────────
  const draftBody = () => {
    const body = {
      order_type: orderType,
      notes:      notes.trim() || null,
      items: items
        .filter((i) => i.product_id)
        .map((i) => ({
          product_id:          Number(i.product_id),
          quantity:            Number(i.quantity) || 0,
          unit_price:          i.unit_price === '' ? 0 : Number(i.unit_price),
          unit_deposit_fee:    Number(i.unit_deposit_fee) || 0,
          units_per_case:      Number(i.units_per_case) || 1,
          is_price_overridden: false,
        })),
      personnel: assignedPersonnel,
    };
    if (customerId) body.customer_id = Number(customerId);
    return body;
  };

  // Create the draft the moment a customer is chosen
  useEffect(() => {
    if (!isDraftMode || !customerId || draftIdRef.current || creatingDraftRef.current) return;
    creatingDraftRef.current = true;
    setDraftStatus('saving');
    const promise = api.post('/orders', { ...draftBody(), status: 'draft' })
      .then((created) => {
        draftIdRef.current = created.id;
        setDraftId(created.id);
        setDraftStatus('saved');
        return created.id;
      })
      .catch(() => {
        creatingDraftRef.current = false;
        setDraftStatus('idle');
      })
      .finally(() => {
        // Clear the in-flight reference once settled so handleSubmit won't wait again
        if (draftPromiseRef.current === promise) draftPromiseRef.current = null;
      });
    draftPromiseRef.current = promise;
  }, [isDraftMode, customerId, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced auto-save on any change once the draft exists
  useEffect(() => {
    if (!isDraftMode || !draftId || saving) return;
    setDraftStatus('saving');
    const t = setTimeout(() => {
      autoSaveTimerRef.current = null;
      api.patch(`/orders/${draftId}`, draftBody())
        .then(() => setDraftStatus('saved'))
        .catch(() => setDraftStatus('idle'));
    }, 800);
    autoSaveTimerRef.current = t;
    return () => { clearTimeout(t); if (autoSaveTimerRef.current === t) autoSaveTimerRef.current = null; };
  }, [isDraftMode, draftId, saving, customerId, orderType, notes, items, assignedPersonnel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset Button Handler (decisions.md G10) ────────────────────────────────
  // Clears order lines, adjustment, and notes. Keeps customer, orderType, and draft alive.
  // Confirm only when there are lines to lose; zero lines -> no dialog.
  const handleReset = () => {
    if (items.length > 0) {
      setConfirmingReset(true);
    } else {
      executeReset();
    }
  };

  const executeReset = () => {
    setItems([]);
    setAdjValue('');
    setAdjReason('');
    setAdjExpanded(false);
    setNotes('');
    setErrors({});
    setConfirmingReset(false);
    addToast('Order lines reset.', 'info');
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const validate = () => {
    const e = {};
    if (!customerId) e.customer = 'Select a customer.';
    if (items.length === 0) e.items = 'Add at least one product.';
    if (items.some((i) => !i.product_id)) e.items = 'All items must have a product selected.';
    if (items.some((i) => !Number(i.quantity))) e.items = 'All quantities must be greater than 0.';
    if (items.some((i) => i.unit_price === '' || Number.isNaN(Number(i.unit_price)))) e.items = 'All items must have a price.';
    if (items.some((i) => Number(i.unit_price) < 0)) e.items = 'Item prices cannot be negative.';
    if (Number(adjValue) !== 0 && !adjReason.trim()) e.adjustment = 'Adjustment reason is required.';
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    const dirtyItems = items.reduce((acc, i) => {
      const product = products.find((p) => String(p.id) === i.product_id);
      if (product && Number(i.unit_price) !== priceFor(product)) {
        acc.push({
          product_id:   Number(i.product_id),
          product_name: i.product_name,
          sku:          i.sku,
          unit_price:   Number(i.unit_price),
        });
      }
      return acc;
    }, []);

    setSaving(true);

    // Cancel any pending debounced auto-save so it can't race with our explicit PATCH below.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    try {
      const payload = {
        customer_id: Number(customerId),
        order_type:  orderType,
        notes:       notes.trim() || null,
        items: items.map((i) => ({
          product_id:          Number(i.product_id),
          quantity:            Number(i.quantity),
          unit_price:          Number(i.unit_price),
          unit_deposit_fee:    Number(i.unit_deposit_fee) || 0,
          units_per_case:      Number(i.units_per_case) || 1,
          is_price_overridden: false,
        })),
        personnel: assignedPersonnel,
      };

      let orderId;
      if (isRealEdit) {
        await api.patch(`/orders/${editOrder.id}`, payload);
        orderId = editOrder.id;
        addToast('Order updated.', 'success');
      } else {
        // If a draft creation is still in-flight, wait for it to resolve so we have the draft id.
        if (draftPromiseRef.current) {
          await draftPromiseRef.current;
        }
        // Re-read ref after awaiting (state may not have updated yet due to batching).
        const resolvedDraftId = draftIdRef.current;
        if (resolvedDraftId) {
          await api.patch(`/orders/${resolvedDraftId}`, payload);
          await api.post(`/orders/${resolvedDraftId}/finalize`, {});
          orderId = resolvedDraftId;
        } else {
          // No draft was ever created (e.g. draft creation failed) — fall back to a fresh POST.
          const created = await api.post('/orders', payload);
          orderId = created.id;
        }
        addToast('Order created.', 'success');
      }

      const adjNum            = Number(adjValue) || 0;
      const existingAdjNum    = isRealEdit ? (Number(editOrder.adjustment) || 0) : 0;
      const existingAdjReason = isRealEdit ? (editOrder.adjustment_reason || '') : '';
      if (adjNum !== existingAdjNum || adjReason.trim() !== existingAdjReason) {
        await api.patch(`/orders/${orderId}/adjustment`, {
          adjustment: adjNum,
          adjustment_reason: adjReason.trim(),
        });
      }

      if (dirtyItems.length && selectedCustomer) {
        setPriceSavePrompt({
          step: 'first', orderId, customer: selectedCustomer, orderType,
          dirty: dirtyItems, busy: false,
        });
      } else {
        onSaved(orderId);
      }
    } catch (err) {
      addToast(err.message || 'Failed to save order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Save custom price prompt handlers ──────────────────────────────────────
  const declinePriceSave = () => {
    setPriceSavePrompt(null);
    onSaved(priceSavePrompt?.orderId);
  };

  // ADR 0009: saving a price is a pricing action, not a re-tagging action. It writes to
  // customer_product_prices and touches nothing else — the second "pick a customer type"
  // step V1 forced on the operator is gone with the coupling that needed it.
  const persistPriceSave = async () => {
    setPriceSavePrompt((p) => ({ ...p, busy: true }));
    try {
      await Promise.all(priceSavePrompt.dirty.map((d) =>
        api.post(`/customers/${priceSavePrompt.customer.id}/prices`, {
          product_id:        d.product_id,
          custom_unit_price: d.unit_price,
          order_type:        priceSavePrompt.orderType,
        })
      ));
      addToast('Custom price saved.', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to save custom price.', 'error');
    } finally {
      setPriceSavePrompt(null);
      onSaved(priceSavePrompt?.orderId);
    }
  };

  // Discard draft completely (distinct from Reset)
  const handleDiscard = async () => {
    if (!draftId) { onClose(); return; }
    setSaving(true);
    try {
      await api.del(`/orders/${draftId}`);
      addToast('Draft discarded.', 'success');
      onSaved(); // no orderId -> returns to list
    } catch (err) {
      addToast(err.message || 'Failed to discard draft.', 'error');
      setSaving(false);
    }
  };

  const totals = orderTotals(items, Number(adjValue) || 0);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-modal-title"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-white w-full max-w-7xl h-[95vh] rounded-2xl flex flex-col shadow-2xl overflow-hidden border border-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 shrink-0 bg-white">
            <div className="min-w-0">
              <h2 id="order-modal-title" className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <span>{isRealEdit ? `Edit Order ${orderRef(editOrder)}` : isDraftResume ? `Draft ${orderRef(editOrder)}` : 'New Order'}</span>
              </h2>
              {isDraftMode && draftId && (
                <p className="text-xs font-medium mt-0.5 text-slate-500">
                  {draftStatus === 'saving' ? '● Saving draft…' : '✓ Draft saved automatically'}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400
                         hover:text-slate-700 hover:bg-slate-100 transition-colors
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              ✕
            </button>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem] divide-y lg:divide-y-0 lg:divide-x divide-slate-200 overflow-hidden">
              
              {/* ── LEFT COLUMN: Product Catalogue ──────────────────── */}
              <div className="flex flex-col min-h-0 h-full p-4 sm:p-5 overflow-hidden bg-slate-50/40">
                <POSProductGrid
                  products={activeProducts}
                  orderQty={orderQty}
                  onAdd={addProduct}
                  priceFor={priceFor}
                />
              </div>

              {/* ── RIGHT COLUMN: Order Panel ───────────────────────── */}
              <div className="flex flex-col min-h-0 h-full overflow-hidden bg-white">
                
                {/* Order Header: Customer & Order Type */}
                <div className="p-4 border-b border-slate-200 shrink-0 space-y-3 bg-white">
                  <div>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Customer</p>
                    <Combobox
                      items={activeCustomers}
                      match={customerMatches}
                      value={selectedCustomer ?? null}
                      displayValue={(c) => c.name}
                      minChars={1}
                      onSelect={(c) => setCustomerId(String(c.id))}
                      onQueryChange={() => setCustomerId('')}
                      onCreate={handleCreateCustomer}
                      creating={creatingCustomer}
                      renderCreate={(name) => (
                        <>
                          <span className="text-lg leading-none">＋</span>
                          <span>Create <span className="font-bold">“{name}”</span> as a new Customer</span>
                        </>
                      )}
                      placeholder="Search or type a new customer name…"
                      emptyText="No customers match."
                      aria-label="Customer"
                      renderRow={(c) => (
                        <>
                          <span className="min-w-0 truncate">
                            <span className="font-medium text-slate-800">{c.name}</span>
                            {c.address && (
                              <span className="italic text-slate-400"> - {c.address}</span>
                            )}
                          </span>
                          {c.customer_type && c.customer_type !== 'regular' && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border shrink-0 ${customerTypeBadge(c.customer_type)}`}>
                              {customerTypeLabel(c.customer_type)}
                            </span>
                          )}
                        </>
                      )}
                    />
                    {selectedCustomer && (
                      <div className="mt-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-1.5 flex-wrap">
                          <span className="font-bold text-slate-900">{selectedCustomer.name}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold border ${customerTypeBadge(selectedCustomer.customer_type)}`}>
                            {customerTypeLabel(selectedCustomer.customer_type).toUpperCase()}
                          </span>
                        </div>
                        {/* ADR 0009 — pricing is derived from the saved rows, not the tag above. */}
                        {hasCustomPricing(customPrices) && (
                          <p className="font-semibold text-emerald-700">
                            ✓ Saved {orderType} prices applied ({Object.keys(customPrices).length} product{Object.keys(customPrices).length === 1 ? '' : 's'})
                          </p>
                        )}
                        {selectedCustomer.address && (
                          <p className="text-slate-600 truncate"><span className="font-medium text-slate-500">Address:</span> {selectedCustomer.address}</p>
                        )}
                        {selectedCustomer.phone && (
                          <p className="text-slate-600"><span className="font-medium text-slate-500">Phone:</span> {selectedCustomer.phone}</p>
                        )}
                      </div>
                    )}
                    {errors.customer && <p className="text-xs text-red-600 mt-1 font-medium">{errors.customer}</p>}
                  </div>

                  {!isEdit && (
                    <div>
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Order Type</p>
                      <div className="flex gap-2" role="group" aria-label="Order type">
                        {['delivery', 'pickup'].map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setOrderType(type)}
                            aria-pressed={orderType === type}
                            className={`flex-1 h-10 rounded-xl text-sm font-semibold border transition-colors
                              ${orderType === type
                                ? type === 'delivery'
                                  ? 'bg-slate-800 text-white border-slate-800 shadow-sm'
                                  : 'bg-blue-700 text-white border-blue-700 shadow-sm'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                          >
                            {type === 'delivery' ? '🚚 Delivery' : '🏪 Pickup'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Scrollable Order Items & Sections */}
                <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
                  {isEdit && ['in_transit', 'completed', 'done'].includes(editOrder?.status) && (
                    <div className="p-2.5 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-800">
                      ⚠ This order has been dispatched — changing items will automatically adjust inventory.
                    </div>
                  )}

                  {/* Line Items List */}
                  <div>
                    {errors.items && <p className="text-xs text-red-600 mb-2 font-medium">{errors.items}</p>}

                    {items.length === 0 ? (
                      <div className="py-12 text-center text-sm text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
                        Tap a product on the left to start the order.
                      </div>
                    ) : (
                      <ul className="space-y-2.5">
                        {items.map((item) => (
                          <li
                            key={item._key}
                            className="p-3 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-slate-50 transition-colors"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-slate-900 truncate" title={item.product_name}>
                                  {item.sku || item.product_name}
                                </p>
                                {item.sku && (
                                  <p className="text-xs text-slate-500 truncate">{item.product_name}</p>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeItem(item._key)}
                                aria-label={`Remove ${item.product_name}`}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400
                                           hover:text-red-600 hover:bg-red-50 shrink-0 transition-colors"
                              >
                                ✕
                              </button>
                            </div>

                            <div className="mt-2.5 flex items-end justify-between gap-2">
                              <CaseStepper
                                quantity={item.quantity}
                                label={item.product_name}
                                onStep={(delta) => stepItem(item._key, delta)}
                              />

                              <div className="w-28">
                                <label
                                  htmlFor={`price-${item._key}`}
                                  className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
                                >
                                  Price /cs
                                </label>
                                <input
                                  id={`price-${item._key}`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.unit_price}
                                  onChange={(e) => updateItemPrice(item._key, e.target.value)}
                                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-right text-sm font-semibold tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                                />
                              </div>

                              <div className="text-right">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Total</p>
                                <p className="text-base font-bold text-slate-900 tabular-nums">
                                  {PHP(lineTotal(item))}
                                </p>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Adjustment Section */}
                  <div className="pt-2 border-t border-slate-200">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Adjustment</p>
                        {!adjExpanded && Number(adjValue) !== 0 && (
                          <p className="text-xs font-semibold text-blue-800 mt-0.5">
                            {Number(adjValue) > 0 ? '+' : ''}{PHP(adjValue)}
                            {adjReason && ` — ${adjReason}`}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setAdjExpanded((v) => !v)}
                        className="text-xs text-blue-700 hover:text-blue-900 font-semibold focus-visible:outline-none"
                      >
                        {adjExpanded ? 'Close' : Number(adjValue) !== 0 ? 'Edit' : '+ Add Adjustment'}
                      </button>
                    </div>

                    {adjExpanded && (
                      <div className="mt-2.5 space-y-2">
                        <FormField label="Amount (₱) — negative for discount">
                          <input
                            type="number"
                            step="0.01"
                            value={adjValue}
                            onChange={(e) => setAdjValue(e.target.value)}
                            className={INPUT}
                            placeholder="e.g. -50 for discount, 200 for surcharge"
                          />
                        </FormField>
                        <FormField label={`Reason${Number(adjValue) !== 0 ? ' *' : ''}`}>
                          <input
                            type="text"
                            value={adjReason}
                            onChange={(e) => setAdjReason(e.target.value)}
                            className={INPUT}
                            placeholder="e.g. Suki discount"
                          />
                        </FormField>
                        {errors.adjustment && <p className="text-xs text-red-600">{errors.adjustment}</p>}
                      </div>
                    )}
                  </div>

                  {/* Notes Section */}
                  <div className="pt-2 border-t border-slate-200">
                    <FormField label="Notes" hint="Optional">
                      <input
                        type="text"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className={INPUT}
                        placeholder={orderType === 'pickup' ? 'Instructions for pickup…' : 'Instructions for delivery…'}
                      />
                    </FormField>
                  </div>

                  {/* Assigned Personnel */}
                  {activePersonnel.length > 0 && (
                    <div className="pt-2 border-t border-slate-200">
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                        Personnel <span className="font-normal text-slate-400">(optional)</span>
                      </p>
                      <div className="space-y-1.5">
                        {activePersonnel.map((person) => {
                          const assigned = assignedPersonnel.find((p) => p.id === person.id);
                          return (
                            <div
                              key={person.id}
                              className={`flex items-center gap-2 p-2 rounded-lg border text-xs transition-colors
                                ${assigned ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200'}`}
                            >
                              <input
                                type="checkbox"
                                id={`pers-${person.id}`}
                                checked={Boolean(assigned)}
                                onChange={() => togglePersonnel(person)}
                                className="w-4 h-4 accent-blue-700 shrink-0"
                              />
                              <label htmlFor={`pers-${person.id}`} className="flex-1 cursor-pointer font-medium text-slate-800 truncate">
                                {person.full_name}
                              </label>
                              {assigned && (
                                <div className="flex gap-1 shrink-0">
                                  {['Driver', 'Helper'].map((role) => (
                                    <button
                                      key={role}
                                      type="button"
                                      onClick={() => setPersonnelRole(person.id, role)}
                                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border
                                        ${assigned.role === role
                                          ? 'bg-blue-700 text-white border-blue-700'
                                          : 'bg-white text-slate-600 border-slate-300'}`}
                                    >
                                      {role}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer: Running Totals & Action Row */}
                <div className="p-4 border-t border-slate-200 bg-slate-50/50 shrink-0 space-y-3">
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between text-slate-600">
                      <span>Items ({totalCases(items)} cs)</span>
                      <span className="tabular-nums font-medium text-slate-900">{PHP(totals.goods)}</span>
                    </div>
                    {totals.adjustment !== 0 && (
                      <div className="flex justify-between text-slate-600 text-xs">
                        <span>Adjustment{adjReason ? ` (${adjReason})` : ''}</span>
                        <span className={`tabular-nums font-semibold ${totals.adjustment > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                          {totals.adjustment > 0 ? '+' : ''}{PHP(totals.adjustment)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between pt-1 border-t border-slate-200">
                      <span className="text-base font-bold uppercase tracking-wider text-slate-900">Total Due</span>
                      <span className="text-2xl font-black tabular-nums text-slate-900">{PHP(totals.total)}</span>
                    </div>
                  </div>

                  {confirmingDiscard ? (
                    <div className="flex items-center justify-between gap-2 p-2 bg-red-50 border border-red-200 rounded-xl">
                      <span className="text-xs font-medium text-red-800">Discard draft?</span>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setConfirmingDiscard(false)} disabled={saving}>Keep</Button>
                        <Button size="sm" variant="danger" onClick={handleDiscard} loading={saving}>Discard</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {/* G10 Reset Button */}
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleReset}
                        disabled={saving || (items.length === 0 && !adjValue && !notes)}
                        className="text-slate-700"
                        title="Reset order items and notes while keeping customer"
                      >
                        🔄 Reset
                      </Button>

                      {isDraftMode && draftId && (
                        <button
                          type="button"
                          onClick={() => setConfirmingDiscard(true)}
                          disabled={saving}
                          className="text-xs font-semibold text-red-600 hover:text-red-700 hover:underline px-2 py-1 disabled:opacity-50"
                        >
                          Discard
                        </button>
                      )}

                      <div className="flex-1" />

                      <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={saving}
                      >
                        {isDraftMode && draftId ? 'Close' : 'Cancel'}
                      </Button>

                      <Button
                        onClick={handleSubmit}
                        loading={saving}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                      >
                        {isRealEdit ? 'Save Changes' : '💾 Create Order'}
                      </Button>
                    </div>
                  )}
                </div>

              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── G10 Reset Confirm Modal ────────────────────────────────────── */}
      {confirmingReset && (
        <Modal
          title="Reset order lines?"
          onClose={() => setConfirmingReset(false)}
          onConfirm={executeReset}
          confirmLabel="Yes, Reset"
          confirmVariant="warning"
        >
          <p className="text-slate-600">
            This will clear all item lines, adjustment, and notes{selectedCustomer ? ` for ${selectedCustomer.name}` : ''}.
            The selected customer and order type will be kept.
          </p>
        </Modal>
      )}

      {/* ── Save custom price? (step 1) ────────────────────────────────── */}
      {priceSavePrompt?.step === 'first' && (
        <Modal
          title="Save Custom Price?"
          onClose={declinePriceSave}
          onConfirm={persistPriceSave}
          confirmLabel="Yes, Save"
          cancelLabel="No"
          loading={priceSavePrompt.busy}
        >
          <p className="text-slate-700">
            Save the custom price{priceSavePrompt.dirty.length > 1 ? 's' : ''} for{' '}
            <strong>{priceSavePrompt.customer.name}</strong> on future{' '}
            <strong>{priceSavePrompt.orderType}</strong> orders?
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {priceSavePrompt.dirty.map((d) => (
              <li key={d.product_id} className="flex items-center justify-between border-b border-slate-200 pb-1.5">
                <span className="text-slate-700">{d.sku || d.product_name}</span>
                <span className="font-semibold text-slate-900 tabular-nums">{PHP(d.unit_price)}</span>
              </li>
            ))}
          </ul>
        </Modal>
      )}

    </>
  );
}
