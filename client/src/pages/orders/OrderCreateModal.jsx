import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import Stepper from '../../components/ui/Stepper';
import Modal from '../../components/ui/Modal';
import { productMatches } from '../../utils/productSearch';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const INPUT_SM = `w-full h-10 px-3 border border-slate-300 rounded-lg text-sm text-slate-900
                  focus:outline-none focus:ring-2 focus:ring-blue-600`;

const newItem = () => ({
  _key:                   Math.random(),
  _productSearch:         '',
  requires_bottle_return: false,
  product_id:             '',
  product_name:           '',
  unit:                   '',
  quantity:               '1',
  unit_price:             '',
  unit_deposit_fee:       '0',
  units_per_case:         1,
});

export default function OrderCreateModal({ onClose, onSaved, editOrder = null }) {
  const { addToast } = useToast();
  const isEdit = Boolean(editOrder);

  // Draft modes: a brand-new order and a resumed draft both auto-save as a 'draft' order.
  // A "real edit" (editing a live pending/in_transit/… order) keeps the single-submit flow.
  const isDraftResume = editOrder?.status === 'draft';
  const isRealEdit    = isEdit && !isDraftResume;
  const isDraftMode   = !isRealEdit;

  const [customers, setCustomers]         = useState([]);
  const [products, setProducts]           = useState([]);
  const [activePersonnel, setActivePersonnel] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);

  const [orderType, setOrderType]         = useState(editOrder?.order_type ?? 'delivery');
  const [customerId, setCustomerId]       = useState(editOrder?.customer_id ?? '');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customPrices, setCustomPrices]   = useState({});
  const [items, setItems]                 = useState(
    editOrder?.items?.map((i) => ({
      _key:                   Math.random(),
      _productSearch:         i.sku || i.product_name,
      requires_bottle_return: i.requires_bottle_return ?? false,
      product_id:             String(i.product_id),
      product_name:           i.product_name,
      unit:                   i.unit,
      quantity:               String(i.quantity),
      unit_price:             String(i.unit_price),
      unit_deposit_fee:       String(i.unit_deposit_fee),
      units_per_case:         i.units_per_case ?? 1,
    })) ?? [newItem()]
  );
  const [openDropdownKey, setOpenDropdownKey] = useState(null);
  const [dupConfirm, setDupConfirm] = useState(null);
  const [assignedPersonnel, setAssignedPersonnel] = useState(
    editOrder?.personnel?.map((p) => ({ id: p.personnel_id, role: p.role })) ?? []
  );
  const [notes, setNotes] = useState(editOrder?.notes ?? '');
  const [errors, setErrors] = useState({});

  // ── Draft auto-save state ────────────────────────────────────────────────────
  const [draftId, setDraftId]           = useState(isDraftResume ? editOrder.id : null);
  const [draftStatus, setDraftStatus]   = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const creatingDraftRef = useRef(false);

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
        if (editOrder?.customer_id) {
          const c = custs.find((x) => x.id === editOrder.customer_id);
          if (c) setCustomerSearch(c.name);
        }
      })
      .catch(() => addToast('Failed to load form data.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const selectedCustomer = customers.find((c) => String(c.id) === String(customerId));

  // Load wholesaler custom prices when customer or order_type changes
  useEffect(() => {
    if (!customerId || selectedCustomer?.customer_type !== 'wholesaler') {
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
  }, [customerId, selectedCustomer?.customer_type, orderType]);

  const filteredCustomers = customers.filter((c) =>
    c.is_active && c.name.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const [showCustomerList, setShowCustomerList] = useState(false);

  const selectCustomer = (c) => {
    setCustomerId(String(c.id));
    setCustomerSearch(c.name);
    setShowCustomerList(false);
  };

  // ── Line item helpers ──────────────────────────────────────────────────────

  // New rows go on TOP so the next product is always right under the Add button
  // — no scrolling back down on long orders. The fresh row auto-focuses.
  const addItem = () => setItems((prev) => [{ ...newItem(), _autoFocus: true }, ...prev]);

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i._key !== key));

  const updateItem = (key, field, value) =>
    setItems((prev) => prev.map((i) => i._key === key ? { ...i, [field]: value } : i));

  const applyProduct = (key, productId) => {
    const product = products.find((p) => String(p.id) === productId);
    if (!product) {
      updateItem(key, 'product_id', '');
      return;
    }
    const customEntry = customPrices[product.id];
    const displayName = product.sku || product.name;
    setItems((prev) => prev.map((i) => i._key === key ? {
      ...i,
      _productSearch:         displayName,
      requires_bottle_return: product.requires_bottle_return || false,
      product_id:             productId,
      product_name:           product.name,
      unit:                   product.unit,
      units_per_case:         product.units_per_case || 1,
      unit_price:             customEntry
        ? String(customEntry.custom_unit_price)
        : String(product.base_wholesale_price),
      unit_deposit_fee:       String(product.deposit_fee),
    } : i));
  };

  // Warn before adding a product that's already on another line of this order.
  const selectProduct = (key, productId) => {
    const isDup = items.some((i) => i._key !== key && i.product_id === productId);
    if (isDup) { setDupConfirm({ key, productId }); return; }
    applyProduct(key, productId);
  };

  const lineTotal = (item) => {
    const qty   = Number(item.quantity) || 0;
    const price = Number(item.unit_price) || 0;
    return qty * price;
  };

  const grandTotal = items.reduce((sum, i) => sum + lineTotal(i), 0);

  // ── Personnel helpers ──────────────────────────────────────────────────────

  const isAssigned = (id) => assignedPersonnel.some((p) => p.id === id);

  const togglePersonnel = (person) => {
    setAssignedPersonnel((prev) => {
      if (prev.some((p) => p.id === person.id)) {
        return prev.filter((p) => p.id !== person.id);
      }
      // Only one Driver per order — first assignee takes the spot, the rest start as Helpers.
      const hasDriver = prev.some((p) => p.role === 'Driver');
      return [...prev, { id: person.id, role: hasDriver ? 'Helper' : 'Driver' }];
    });
  };

  // Making someone the Driver demotes the previous Driver to Helper (radio-button
  // behaviour) so an order never has more than one Driver.
  const setPersonnelRole = (personId, role) =>
    setAssignedPersonnel((prev) =>
      prev.map((p) => {
        if (p.id === personId) return { ...p, role };
        if (role === 'Driver' && p.role === 'Driver') return { ...p, role: 'Helper' };
        return p;
      })
    );

  // ── Draft auto-save ──────────────────────────────────────────────────────────

  // Body for draft create/update. Only rows with a product chosen are sent; blank
  // quantity/price are tolerated server-side (a draft can be incomplete). customer_id
  // is omitted while the search box is mid-edit (transiently empty) so it's not wiped.
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

  // Create the draft the moment a customer is chosen (the "draft started" trigger).
  useEffect(() => {
    if (!isDraftMode || !customerId || draftId || creatingDraftRef.current) return;
    creatingDraftRef.current = true;
    setDraftStatus('saving');
    api.post('/orders', { ...draftBody(), status: 'draft' })
      .then((created) => { setDraftId(created.id); setDraftStatus('saved'); })
      .catch(() => { creatingDraftRef.current = false; setDraftStatus('idle'); });
  }, [isDraftMode, customerId, draftId]); // eslint-disable-line

  // Debounced auto-save on any change once the draft exists. Paused while finalizing/discarding.
  useEffect(() => {
    if (!isDraftMode || !draftId || saving) return;
    setDraftStatus('saving');
    const t = setTimeout(() => {
      api.patch(`/orders/${draftId}`, draftBody())
        .then(() => setDraftStatus('saved'))
        .catch(() => setDraftStatus('idle'));
    }, 800);
    return () => clearTimeout(t);
  }, [isDraftMode, draftId, saving, customerId, orderType, notes, items, assignedPersonnel]); // eslint-disable-line

  // ── Submit ─────────────────────────────────────────────────────────────────

  const validate = () => {
    const e = {};
    if (!customerId) e.customer = 'Select a customer.';
    if (items.some((i) => !i.product_id)) e.items = 'All items must have a product selected.';
    if (items.some((i) => !Number(i.quantity))) e.items = 'All quantities must be greater than 0.';
    if (items.some((i) => i.unit_price === '')) e.items = 'All items must have a price.';
    if (items.length === 0) e.items = 'Add at least one product.';
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      const payload = {
        customer_id: Number(customerId),
        order_type:  orderType,
        notes:       notes.trim() || null,
        items: items.map((i) => ({
          product_id:       Number(i.product_id),
          quantity:         Number(i.quantity),
          unit_price:       Number(i.unit_price),
          unit_deposit_fee: Number(i.unit_deposit_fee),
          units_per_case:   Number(i.units_per_case) || 1,
          is_price_overridden: false,
        })),
        personnel: assignedPersonnel,
      };

      if (isRealEdit) {
        await api.patch(`/orders/${editOrder.id}`, payload);
        addToast('Order updated.', 'success');
      } else if (draftId) {
        // Draft → save the validated final state, then promote it to a Pending order.
        await api.patch(`/orders/${draftId}`, payload);
        await api.post(`/orders/${draftId}/finalize`, {});
        addToast('Order created.', 'success');
      } else {
        // No draft was created yet (e.g. created instantly) — fall back to a direct create.
        await api.post('/orders', payload);
        addToast('Order created.', 'success');
      }
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to save order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    if (!draftId) { onClose(); return; }
    setSaving(true);
    try {
      await api.del(`/orders/${draftId}`);
      addToast('Draft discarded.', 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to discard draft.', 'error');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="order-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white w-full sm:rounded-xl sm:max-w-2xl h-[95vh] sm:h-auto sm:max-h-[95vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <h2 id="order-modal-title" className="text-xl font-bold text-slate-900">
              {isRealEdit ? `Edit Order #${editOrder.id}` : isDraftResume ? `Draft #${editOrder.id}` : 'New Order'}
            </h2>
            {isDraftMode && draftId && (
              <p className="text-xs font-medium mt-0.5 text-slate-400">
                {draftStatus === 'saving'
                  ? '● Saving draft…'
                  : '✓ Draft saved automatically'}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">

              {/* ── Dispatched warning ──────────────────────────────── */}
              {isEdit && ['in_transit', 'completed', 'done'].includes(editOrder?.status) && (
                <div className="mx-6 mt-5 p-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-800">
                  ⚠ This order has been dispatched — changing items will automatically adjust inventory.
                </div>
              )}

              {/* ── Order Type ──────────────────────────────────────── */}
              {!isEdit && (
                <div className="px-6 py-5 border-b border-slate-200">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Order Type</p>
                  <div className="flex gap-2">
                    {['delivery', 'pickup'].map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setOrderType(type)}
                        className={`flex-1 h-11 rounded-lg text-sm font-semibold border transition-colors
                          ${orderType === type
                            ? type === 'delivery'
                              ? 'bg-slate-800 text-white border-slate-800'
                              : 'bg-blue-700 text-white border-blue-700'
                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                      >
                        {type === 'delivery' ? '🚚 Delivery' : '🏪 Pickup'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Customer ────────────────────────────────────────── */}
              <div className="px-6 py-5 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Customer</p>
                <div className="relative">
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value);
                      setCustomerId('');
                      setShowCustomerList(true);
                    }}
                    onFocus={() => setShowCustomerList(true)}
                    onBlur={() => setTimeout(() => setShowCustomerList(false), 150)}
                    className={INPUT}
                    placeholder="Search customer name…"
                    aria-label="Customer search"
                  />
                  {showCustomerList && filteredCustomers.length > 0 && (
                    <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {filteredCustomers.slice(0, 20).map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onMouseDown={() => selectCustomer(c)}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-blue-50 flex items-center justify-between gap-2"
                          >
                            <span className="font-medium text-slate-800">{c.name}</span>
                            {c.customer_type === 'wholesaler' && (
                              <span className="text-xs font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full border border-amber-300">
                                Wholesaler
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {selectedCustomer && (
                  <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border
                        ${selectedCustomer.customer_type === 'wholesaler'
                          ? 'bg-amber-100 text-amber-800 border-amber-300'
                          : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {selectedCustomer.customer_type === 'wholesaler' ? 'Wholesaler — custom pricing applied' : 'Regular Customer'}
                      </span>
                    </div>
                    {selectedCustomer.phone && (
                      <p className="text-sm text-slate-600">
                        <span className="font-medium text-slate-500">Phone:</span> {selectedCustomer.phone}
                      </p>
                    )}
                    {selectedCustomer.address && (
                      <p className="text-sm text-slate-600">
                        <span className="font-medium text-slate-500">Address:</span> {selectedCustomer.address}
                      </p>
                    )}
                    {selectedCustomer.notes && (
                      <p className="text-sm text-slate-600">
                        <span className="font-medium text-slate-500">Notes:</span> {selectedCustomer.notes}
                      </p>
                    )}
                  </div>
                )}
                {errors.customer && (
                  <p className="text-sm text-red-600 mt-2">{errors.customer}</p>
                )}
              </div>

              {/* ── Line Items ──────────────────────────────────────── */}
              <div className="px-6 py-5 border-b border-slate-200">
                <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Products</p>
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-slate-500">
                      Total{' '}
                      <span className="text-base font-bold text-slate-900 tabular-nums">{PHP(grandTotal)}</span>
                    </p>
                    <Button size="sm" variant="secondary" onClick={addItem}>+ Add Product</Button>
                  </div>
                </div>

                {errors.items && (
                  <p className="text-sm text-red-600 mb-3">{errors.items}</p>
                )}

                <div className="space-y-3">
                  {items.map((item, idx) => (
                    <div key={item._key} className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                      <div className="flex items-start gap-2 mb-2">
                        <div className="relative flex-1">
                          <input
                            type="text"
                            value={item._productSearch}
                            onChange={(e) => {
                              setItems((prev) => prev.map((i) =>
                                i._key === item._key
                                  ? { ...i, _productSearch: e.target.value, product_id: '', product_name: '' }
                                  : i
                              ));
                              setOpenDropdownKey(item._key);
                            }}
                            onFocus={() => setOpenDropdownKey(item._key)}
                            onBlur={() => setTimeout(() => setOpenDropdownKey(null), 150)}
                            className={INPUT_SM + ' w-full'}
                            placeholder="Search product…"
                            aria-label={`Product ${idx + 1}`}
                            autoComplete="off"
                            autoFocus={item._autoFocus}
                          />
                          {openDropdownKey === item._key && (() => {
                            const matches = products.filter((p) =>
                              p.is_active && productMatches(p, item._productSearch));
                            return (
                              <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                                {matches.map((p) => (
                                  <li key={p.id}>
                                    <button
                                      type="button"
                                      onMouseDown={() => {
                                        selectProduct(item._key, String(p.id));
                                        setOpenDropdownKey(null);
                                      }}
                                      className="w-full text-left px-4 py-3 text-sm min-h-[48px] hover:bg-blue-50 flex items-center justify-between gap-2"
                                    >
                                      <span className="font-medium text-slate-800 shrink-0">{p.sku || p.name}</span>
                                      {p.sku && <span className="text-xs text-slate-500 truncate">{p.name}</span>}
                                    </button>
                                  </li>
                                ))}
                                {matches.length === 0 && (
                                  <li className="px-4 py-3 text-sm text-slate-400">No products match.</li>
                                )}
                              </ul>
                            );
                          })()}
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

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <FormField label="Qty (cases)">
                          <Stepper
                            value={item.quantity}
                            onChange={(v) => updateItem(item._key, 'quantity', v)}
                            step={0.5}
                            min={0.5}
                            label="Quantity in cases"
                          />
                        </FormField>
                        <FormField label="Price / case (₱)">
                          <input type="number" min="0" step="0.01"
                            value={item.unit_price}
                            onChange={(e) => updateItem(item._key, 'unit_price', e.target.value)}
                            className={INPUT_SM} />
                        </FormField>
                        <FormField label="Deposit / bottle (₱)">
                          <input type="number" min="0" step="0.01"
                            value={item.unit_deposit_fee}
                            disabled={!item.requires_bottle_return}
                            onChange={(e) => updateItem(item._key, 'unit_deposit_fee', e.target.value)}
                            className={INPUT_SM + ' disabled:bg-slate-100 disabled:text-slate-400'} />
                        </FormField>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex justify-end">
                  <div className="text-right">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Order Total</p>
                    <p className="text-2xl font-bold text-slate-900 tabular-nums">{PHP(grandTotal)}</p>
                  </div>
                </div>
              </div>

              {/* ── Personnel ───────────────────────────────────────── */}
              <div className="px-6 py-5 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                  Assigned Personnel <span className="text-slate-300 font-normal normal-case">(optional)</span>
                </p>

                {activePersonnel.length === 0 ? (
                  <p className="text-sm text-slate-400">No active personnel. Add personnel first.</p>
                ) : (
                  <div className="space-y-2">
                    {activePersonnel.map((person) => {
                      const assigned = assignedPersonnel.find((p) => p.id === person.id);
                      return (
                        <div key={person.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border transition-colors
                            ${assigned
                              ? 'bg-blue-50 border-blue-300'
                              : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                        >
                          <input
                            type="checkbox"
                            id={`pers-${person.id}`}
                            checked={Boolean(assigned)}
                            onChange={() => togglePersonnel(person)}
                            className="w-6 h-6 accent-blue-700 shrink-0"
                          />
                          <label htmlFor={`pers-${person.id}`}
                            className="flex-1 cursor-pointer min-w-0">
                            <span className="font-semibold text-slate-800 truncate block">{person.full_name}</span>
                          </label>

                          {assigned && (
                            <div className="flex gap-1 shrink-0">
                              {['Driver', 'Helper'].map((role) => (
                                <button
                                  key={role}
                                  type="button"
                                  onClick={() => setPersonnelRole(person.id, role)}
                                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors
                                    ${assigned.role === role
                                      ? 'bg-blue-700 text-white border-blue-700'
                                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
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
                )}
              </div>

              {/* ── Notes ───────────────────────────────────────────── */}
              <div className="px-6 py-5">
                <FormField label="Notes" hint="Optional">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                               focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                    placeholder={orderType === 'pickup' ? 'Any special instructions for this pickup…' : 'Any special instructions for this delivery…'}
                  />
                </FormField>
              </div>

            </div>

            {/* Footer */}
            <div className="flex gap-3 items-center px-6 py-4 border-t border-slate-200 shrink-0 bg-white">
              {confirmingDiscard ? (
                <>
                  <span className="text-sm text-slate-600 mr-auto">Discard this draft? It can't be undone.</span>
                  <Button variant="secondary" onClick={() => setConfirmingDiscard(false)} disabled={saving}>Keep</Button>
                  <Button variant="danger" onClick={handleDiscard} loading={saving}>Discard</Button>
                </>
              ) : (
                <>
                  {isDraftMode && draftId && (
                    <button
                      type="button"
                      onClick={() => setConfirmingDiscard(true)}
                      disabled={saving}
                      className="text-sm font-semibold text-red-600 hover:text-red-700 hover:underline mr-auto
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded px-1
                                 disabled:opacity-50 disabled:no-underline"
                    >
                      Discard draft
                    </button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={onClose}
                    disabled={saving}
                    className={isDraftMode && draftId ? '' : 'ml-auto'}
                  >
                    {isDraftMode && draftId ? 'Close' : 'Cancel'}
                  </Button>
                  <Button onClick={handleSubmit} loading={saving}>
                    {isRealEdit ? 'Save Changes' : 'Create Order'}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {dupConfirm && (() => {
        const p = products.find((x) => String(x.id) === dupConfirm.productId);
        const name = p ? (p.sku || p.name) : 'this product';
        return (
          <Modal
            title="Product already added"
            onClose={() => setDupConfirm(null)}
            onConfirm={() => { applyProduct(dupConfirm.key, dupConfirm.productId); setDupConfirm(null); }}
            confirmLabel="Yes, add it again"
          >
            There's already an existing <strong>{name}</strong> on this order. Add it again as a
            separate line?
          </Modal>
        );
      })()}
    </div>
  );
}
