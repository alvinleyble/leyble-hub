import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import AmberEditHeader from '../../components/pos/AmberEditHeader';
import POSConfirm from '../../components/pos/POSConfirm';
import POSHistoryModal from '../../components/pos/POSHistoryModal';
import POSProductGrid from '../../components/pos/POSProductGrid';
import POSTicket from '../../components/pos/POSTicket';
import { roundQty } from '../../components/pos/posMath';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintReceipt } from '../orders/usePrintReceipt';

// V2 tablet POS (proposal §2, Slice 1). One screen: catalogue on the left, the live
// ticket on the right, and a 2-tap Save Order → Print Receipt buffer at the bottom.
//
// Only three order states are ever shown here: 📝 Draft (auto-saved, hidden from
// history), ✅ Created (backend `pending`) and 🚫 Cancelled. V2 never advances an
// order past `pending` and never writes order_personnel.
export default function POSPage() {
  const { addToast } = useToast();

  const [products, setProducts]   = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading]     = useState(true);

  // ── Ticket state ───────────────────────────────────────────────────────────
  const [customerId, setCustomerId] = useState('');
  const [orderType, setOrderType]   = useState('delivery');
  const [customPrices, setCustomPrices] = useState({});
  const [items, setItems]           = useState([]);
  const [notes, setNotes]           = useState('');
  const [adjustment, setAdjustment] = useState({ value: '', reason: '' });
  const [errors, setErrors]         = useState({});
  const [saving, setSaving]         = useState(false);

  // ── Draft auto-save (V1 behaviour: create on customer pick, debounced PATCH) ─
  const [draftId, setDraftId]         = useState(null);
  const [draftStatus, setDraftStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const creatingDraftRef = useRef(false);
  const draftPromiseRef  = useRef(null);   // in-flight draft create, awaited by Save Order

  // ── Stage / mode ───────────────────────────────────────────────────────────
  const [savedOrder, setSavedOrder] = useState(null); // set after Save Order → print stage
  const [editOrder, setEditOrder]   = useState(null); // amber edit mode target
  const buildStash = useRef(null);                    // ticket parked while editing

  const mode = editOrder ? 'edit' : savedOrder ? 'saved' : 'build';

  // ── History / alerts ───────────────────────────────────────────────────────
  const [historyOpen, setHistoryOpen]         = useState(false);
  const [historyUnprinted, setHistoryUnprinted] = useState(false);
  const [unprintedToday, setUnprintedToday]   = useState(0);
  const [confirm, setConfirm]                 = useState(null); // { kind, ... }
  const [confirmBusy, setConfirmBusy]         = useState(false);

  // ── Printing ───────────────────────────────────────────────────────────────
  // showDeposit forces the deposit onto the receipt: V2 charges it in full at sale.
  // copies:2 + autoTag = the zero-prompt print of proposal §2.6.
  const [printOrder, setPrintOrder] = useState(null);
  const [printTick, setPrintTick]   = useState(0);
  const printer = usePrintReceipt(
    printOrder,
    {},
    (updated) => {
      setSavedOrder((cur) => (cur && cur.id === updated.id ? updated : cur));
      setPrintOrder((cur) => (cur && cur.id === updated.id ? updated : cur));
      refreshUnprinted();
    },
    { showDeposit: true },
    { copies: 2, autoTag: true }
  );

  useEffect(() => {
    if (printTick > 0) printer.handlePrint();
  }, [printTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestPrint = (order) => {
    setPrintOrder(order);
    setPrintTick((t) => t + 1);
  };

  // ── Data load ──────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([api.get('/products'), api.get('/customers')])
      .then(([prods, custs]) => {
        setProducts(prods.filter((p) => p.is_active));
        setCustomers(custs.filter((c) => c.is_active));
      })
      .catch(() => addToast('Failed to load the catalogue.', 'error'))
      .finally(() => setLoading(false));
    refreshUnprinted();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Orders saved today whose receipt was never confirmed printed — the ⚠️ top-bar alert.
  // Scoped to today so the historical backlog of pending orders never buries it.
  function refreshUnprinted() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    api.get(`/orders?status=pending&from_date=${encodeURIComponent(midnight.toISOString())}`)
      .then((rows) => setUnprintedToday(rows.filter((o) => !o.pending_receipt_printed_at).length))
      .catch(() => {});
  }

  const selectedCustomer = customers.find((c) => String(c.id) === String(customerId)) ?? null;

  // Wholesaler custom prices for the picked customer + channel (same rule as V1).
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

  const priceFor = (product) => {
    const custom = customPrices[product.id];
    return custom ? Number(custom.custom_unit_price) : Number(product.base_wholesale_price);
  };

  // Re-price untouched lines when the customer's price list arrives or the channel
  // changes. Hand-edited lines (_priceEdited) are left exactly as typed.
  useEffect(() => {
    if (mode !== 'build') return;
    setItems((prev) => prev.map((i) => {
      if (i._priceEdited) return i;
      const product = products.find((p) => String(p.id) === i.product_id);
      if (!product) return i;
      const next = String(priceFor(product));
      return next === i.unit_price ? i : { ...i, unit_price: next };
    }));
  }, [customPrices, orderType, products]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Line helpers ───────────────────────────────────────────────────────────

  const ticketQty = useMemo(() => {
    const map = {};
    items.forEach((i) => { map[i.product_id] = (map[i.product_id] || 0) + Number(i.quantity); });
    return map;
  }, [items]);

  const addProduct = (product) => {
    if (mode === 'saved') return;
    setItems((prev) => {
      const existing = prev.find((i) => i.product_id === String(product.id));
      if (existing) {
        return prev.map((i) => i._key === existing._key
          ? { ...i, quantity: roundQty(Number(i.quantity) + 1) }
          : i);
      }
      return [
        {
          _key:             `${product.id}-${Date.now()}`,
          product_id:       String(product.id),
          product_name:     product.name,
          sku:              product.sku || '',
          unit:             product.unit,
          quantity:         1,
          unit_price:       String(priceFor(product)),
          // Deposit only ever rides on products that take bottles back.
          unit_deposit_fee: product.requires_bottle_return ? Number(product.deposit_fee) : 0,
          units_per_case:   product.units_per_case || 1,
          _priceEdited:     false,
        },
        ...prev,
      ];
    });
  };

  const stepItem = (key, delta) => setItems((prev) => {
    const item = prev.find((i) => i._key === key);
    if (!item) return prev;
    const next = roundQty(Number(item.quantity) + delta);
    return next <= 0
      ? prev.filter((i) => i._key !== key)
      : prev.map((i) => (i._key === key ? { ...i, quantity: next } : i));
  });

  const priceItem = (key, value) =>
    setItems((prev) => prev.map((i) =>
      i._key === key ? { ...i, unit_price: value, _priceEdited: true } : i));

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i._key !== key));

  // ── Draft auto-save ────────────────────────────────────────────────────────

  const orderBody = () => {
    const body = {
      order_type: orderType,
      notes:      notes.trim() || null,
      items: items.map((i) => ({
        product_id:          Number(i.product_id),
        quantity:            Number(i.quantity) || 0,
        unit_price:          i.unit_price === '' ? 0 : Number(i.unit_price),
        unit_deposit_fee:    Number(i.unit_deposit_fee) || 0,
        units_per_case:      Number(i.units_per_case) || 1,
        is_price_overridden: false,
      })),
    };
    if (customerId) body.customer_id = Number(customerId);
    return body;
  };

  // Draft starts the moment a customer is chosen.
  useEffect(() => {
    if (mode !== 'build' || !customerId || draftId || creatingDraftRef.current) return;
    creatingDraftRef.current = true;
    setDraftStatus('saving');
    const creating = api.post('/orders', { ...orderBody(), status: 'draft' });
    draftPromiseRef.current = creating;
    creating
      .then((created) => { setDraftId(created.id); setDraftStatus('saved'); })
      .catch(() => { creatingDraftRef.current = false; draftPromiseRef.current = null; setDraftStatus('idle'); });
  }, [mode, customerId, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced auto-save of the live ticket onto the draft.
  useEffect(() => {
    if (mode !== 'build' || !draftId || saving) return;
    setDraftStatus('saving');
    const t = setTimeout(() => {
      api.patch(`/orders/${draftId}`, orderBody())
        .then(() => setDraftStatus('saved'))
        .catch(() => setDraftStatus('idle'));
    }, 800);
    return () => clearTimeout(t);
  }, [mode, draftId, saving, customerId, orderType, notes, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save / update ──────────────────────────────────────────────────────────

  const validate = () => {
    const e = {};
    if (mode === 'build' && !customerId) e.customer = 'Pick a customer first.';
    if (items.length === 0) e.items = 'Add at least one product.';
    else if (items.some((i) => !Number(i.quantity))) e.items = 'Every line needs a quantity.';
    else if (items.some((i) => i.unit_price === '' || Number.isNaN(Number(i.unit_price))))
      e.items = 'Every line needs a price per case.';
    if (Number(adjustment.value) !== 0 && !adjustment.reason.trim())
      e.adjustment = 'Give a reason for the discount / adjustment.';
    return e;
  };

  const finalPayload = () => ({
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
  });

  // Adjustment lives on its own endpoint; only write it when it actually changed.
  const syncAdjustment = async (orderId, previous) => {
    const value  = Number(adjustment.value) || 0;
    const reason = adjustment.reason.trim();
    const prevValue  = Number(previous?.adjustment) || 0;
    const prevReason = previous?.adjustment_reason || '';
    if (value === prevValue && reason === prevReason) return;
    await api.patch(`/orders/${orderId}/adjustment`, { adjustment: value, adjustment_reason: reason });
  };

  // Save Order: draft → Created (backend `pending`), stock deducts server-side.
  // No prompts — printing is the separate second tap.
  const handleSave = async () => {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      // Tapping Save within the first second of picking a customer can land while the
      // draft POST is still in flight — wait for it rather than creating a second order.
      let openDraftId = draftId;
      if (!openDraftId && draftPromiseRef.current) {
        try { openDraftId = (await draftPromiseRef.current).id; } catch (_) { openDraftId = null; }
      }

      let orderId;
      if (openDraftId) {
        await api.patch(`/orders/${openDraftId}`, finalPayload());
        await api.post(`/orders/${openDraftId}/finalize`, {});
        orderId = openDraftId;
      } else {
        const created = await api.post('/orders', finalPayload());
        orderId = created.id;
      }
      await syncAdjustment(orderId, null);

      const full = await api.get(`/orders/${orderId}`);
      setSavedOrder(full);
      setDraftId(null);
      setDraftStatus('idle');
      creatingDraftRef.current = false;
      draftPromiseRef.current = null;
      addToast(`Order #${orderId} created.`, 'success');
      refreshUnprinted();
    } catch (err) {
      addToast(err.message || 'Failed to save the order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Amber Edit Mode: items / prices / adjustment / notes only. The backend accepts a
  // customer or order-type change on drafts alone, so those stay locked (proposal §2.5).
  const handleUpdate = async () => {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      const { customer_id, order_type, ...editable } = finalPayload();
      await api.patch(`/orders/${editOrder.id}`, editable);
      await syncAdjustment(editOrder.id, editOrder);
      addToast(`Order #${editOrder.id} updated.`, 'success');
      exitEditMode();
      refreshUnprinted();
    } catch (err) {
      addToast(err.message || 'Failed to update the order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Ticket lifecycle ───────────────────────────────────────────────────────

  const blankTicket = () => {
    setCustomerId('');
    setOrderType('delivery');
    setItems([]);
    setNotes('');
    setAdjustment({ value: '', reason: '' });
    setErrors({});
    setDraftId(null);
    setDraftStatus('idle');
    creatingDraftRef.current = false;
    draftPromiseRef.current = null;
  };

  const startNewOrder = () => {
    setSavedOrder(null);
    setPrintOrder(null);
    blankTicket();
  };

  const clearTicket = async () => {
    const id = draftId;
    blankTicket();
    if (id) {
      try { await api.del(`/orders/${id}`); } catch (_) { /* draft already gone — nothing to clean up */ }
    }
  };

  const enterEditMode = (order) => {
    // Park whatever is on the ticket so exiting edit mode gives it straight back.
    buildStash.current = mode === 'build'
      ? { customerId, orderType, items, notes, adjustment, draftId, draftStatus }
      : null;

    setSavedOrder(null);
    setPrintOrder(null);
    setEditOrder(order);
    setCustomerId(String(order.customer_id));
    setOrderType(order.order_type);
    setNotes(order.notes ?? '');
    setAdjustment({
      value:  Number(order.adjustment) ? String(order.adjustment) : '',
      reason: order.adjustment_reason ?? '',
    });
    setItems(order.items.map((i) => ({
      _key:             `${i.id}`,
      product_id:       String(i.product_id),
      product_name:     i.product_name,
      sku:              i.sku || '',
      unit:             i.unit,
      quantity:         Number(i.quantity),
      unit_price:       String(Number(i.unit_price)),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case:   Number(i.units_per_case) || 1,
      _priceEdited:     true,
    })));
    setDraftId(null);
    setDraftStatus('idle');
    creatingDraftRef.current = false;
    draftPromiseRef.current = null;
    setErrors({});
    setHistoryOpen(false);
  };

  const exitEditMode = () => {
    setEditOrder(null);
    const stash = buildStash.current;
    buildStash.current = null;
    if (stash) {
      setCustomerId(stash.customerId);
      setOrderType(stash.orderType);
      setItems(stash.items);
      setNotes(stash.notes);
      setAdjustment(stash.adjustment);
      setDraftId(stash.draftId);
      setDraftStatus(stash.draftStatus);
      creatingDraftRef.current = Boolean(stash.draftId);
      setErrors({});
    } else {
      blankTicket();
    }
  };

  const cancelOrder = async (orderId) => {
    setConfirmBusy(true);
    try {
      await api.post(`/orders/${orderId}/status`, { status: 'cancelled' });
      addToast(`Order #${orderId} cancelled — stock restored.`, 'success');
      setConfirm(null);
      if (editOrder?.id === orderId) exitEditMode();
      if (savedOrder?.id === orderId) startNewOrder();
      refreshUnprinted();
    } catch (err) {
      addToast(err.message || 'Failed to cancel the order.', 'error');
    } finally {
      setConfirmBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {/* Top bar: mode badge + print alert + history */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {mode === 'edit' ? (
          <AmberEditHeader orderId={editOrder.id} />
        ) : mode === 'saved' ? (
          <span className="flex min-h-tablet items-center rounded-xl bg-emerald-500/15 px-4 text-lg font-bold text-emerald-200">
            ✅ Order #{savedOrder.id} created
          </span>
        ) : (
          <span className="flex min-h-tablet items-center rounded-xl bg-v2-raised px-4 text-lg font-bold text-v2-muted">
            📝 Draft
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {unprintedToday > 0 && (
            <button
              type="button"
              onClick={() => { setHistoryUnprinted(true); setHistoryOpen(true); }}
              className="flex min-h-tablet items-center rounded-xl bg-amber-500/20 px-4 text-base font-bold
                         text-amber-200 hover:bg-amber-500/30 focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-v2-accent"
            >
              ⚠️ {unprintedToday} order{unprintedToday === 1 ? '' : 's'} today NOT PRINTED
            </button>
          )}
          <button
            type="button"
            onClick={() => { setHistoryUnprinted(false); setHistoryOpen(true); }}
            className="flex min-h-tablet items-center rounded-xl bg-v2-raised px-5 text-lg font-bold text-v2-text
                       hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            🕘 History
          </button>
        </div>
      </div>

      {/* Catalogue + ticket */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem]">
        <POSProductGrid
          products={products}
          ticketQty={ticketQty}
          onAdd={addProduct}
          disabled={mode === 'saved'}
        />

        <POSTicket
          mode={mode}
          customers={customers}
          selectedCustomer={selectedCustomer}
          onSelectCustomer={(c) => setCustomerId(String(c.id))}
          onClearCustomer={() => setCustomerId('')}
          orderType={orderType}
          onOrderType={setOrderType}
          items={items}
          onStep={stepItem}
          onPrice={priceItem}
          onRemove={removeItem}
          notes={notes}
          onNotes={setNotes}
          adjustment={adjustment}
          onAdjustment={setAdjustment}
          errors={errors}
          draftStatus={draftStatus}
          savedOrder={savedOrder}
          editOrderId={editOrder?.id}
          saving={saving}
          printing={printer.printing}
          onSave={handleSave}
          onUpdate={handleUpdate}
          onPrint={() => requestPrint(savedOrder)}
          onNewOrder={startNewOrder}
          onClearTicket={clearTicket}
          onCancelOrder={() => setConfirm({ kind: 'cancel', order: editOrder })}
          onExitEdit={exitEditMode}
        />
      </div>

      {historyOpen && (
        <POSHistoryModal
          unprintedOnlyDefault={historyUnprinted}
          onClose={() => { setHistoryOpen(false); refreshUnprinted(); }}
          onEdit={enterEditMode}
          onReprint={(order) => { setHistoryOpen(false); requestPrint(order); }}
        />
      )}

      {confirm?.kind === 'cancel' && (
        <POSConfirm
          title={`Cancel order #${confirm.order.id}?`}
          confirmLabel="Yes, cancel the order"
          cancelLabel="Keep it"
          danger
          loading={confirmBusy}
          onConfirm={() => cancelOrder(confirm.order.id)}
          onClose={() => setConfirm(null)}
        >
          This voids the order for <strong className="text-v2-text">{confirm.order.customer_name}</strong> and
          puts the stock back. It cannot be undone.
        </POSConfirm>
      )}

      {/* Printer picker (Android only — first print or "change printer") */}
      {printer.pickerVisible && (
        <PrinterPicker
          devices={printer.pickerDevices}
          loading={printer.pickerLoading}
          current={printer.pickerCurrent}
          printPending={printer.printPending}
          onSave={printer.savePrinter}
          onScanWifi={printer.scanWifi}
          onTestPrint={printer.testPrint}
          onClose={printer.closePickerAndCancel}
        />
      )}
    </div>
  );
}
