import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import AmberEditHeader from '../../components/pos/AmberEditHeader';
import POSConfirm from '../../components/pos/POSConfirm';
import POSDraftsModal from '../../components/pos/POSDraftsModal';
import POSHistoryModal from '../../components/pos/POSHistoryModal';
import POSProductGrid from '../../components/pos/POSProductGrid';
import POSOrderPanel from '../../components/pos/POSOrderPanel';
import POSReviewModal from '../../components/pos/POSReviewModal';
import POSSavePriceModal from '../../components/pos/POSSavePriceModal';
import { roundQty, orderTotals } from '../../components/pos/posMath';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintReceipt } from '../orders/usePrintReceipt';
import { orderRef } from '../../utils/orderRef.js';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import {
  saveOrderLocalFirst,
  isOrderUnsynced,
  updateLocalOrder,
  discardLocalOrder,
  listReceipts,
  checkIsOnline,
  triggerOfflineAdvisory,
  cleanupOrphanedDraft,
  parkOrderLocalFirst,
  listLocalParkedOrders,
  mergeParkedOrders,
  isDraftUnsynced,
  updateLocalDraft,
  discardLocalDraft,
  queueOrderDeletion,
  loadCatalogue,
} from '../../offline/index.js';
import { countPossibleDoubleOrders } from '../../utils/duplicateOrders.js';

const TOP_BTN = `flex h-14 items-center gap-2 rounded-xl bg-v2-raised px-5 text-lg font-bold text-v2-text
                 hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

// Small count pill on the Drafts / History buttons. Decorative: each button's aria-label
// spells the same number out, so the count never depends on seeing the badge.
const COUNT_BADGE = `inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-full px-1.5
                     text-sm font-black tabular-nums`;

// V2 tablet POS (proposal §2, Slice 1). One screen: catalogue on the left, the live
// order panel on the right, and a 2-tap Save Order → Print Receipt buffer at the bottom.
//
// Only three order states are ever shown here: 📝 Draft (auto-saved, hidden from
// history), ✅ Created (backend `pending`) and 🚫 Cancelled. V2 never advances an
// order past `pending` and never writes order_personnel.
export default function POSPage() {
  const { addToast } = useToast();

  const [products, setProducts]   = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading]     = useState(true);

  // ── Order state ────────────────────────────────────────────────────────────
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
  const lastSavedAdjRef  = useRef({ value: 0, reason: '' });  // adjustment already on the draft

  // ── Stage / mode ───────────────────────────────────────────────────────────
  const [savedOrder, setSavedOrder] = useState(null); // set after Save Order → print stage
  const [editOrder, setEditOrder]   = useState(null); // amber edit mode target
  const buildStash = useRef(null);                    // order parked while editing

  const mode = editOrder ? 'edit' : savedOrder ? 'saved' : 'build';

  // ── History / drafts / review popups ───────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draftsOpen, setDraftsOpen]   = useState(false);
  const [reviewOpen, setReviewOpen]   = useState(false);
  const [reviewOrder, setReviewOrder] = useState(null);
  // Counts on the two top-bar buttons: parked drafts, and all pending orders whose
  // receipt was never confirmed printed.
  const [draftCount, setDraftCount]         = useState(0);
  const [unprintedCount, setUnprintedCount] = useState(0);
  const [doubleCount, setDoubleCount]       = useState(0); // D6 — possible double parked orders
  const [confirm, setConfirm]         = useState(null); // { kind, ... }
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Save custom price prompt on submit (proposal §4 & save-custom-price-prompt.md)
  const [priceSavePrompt, setPriceSavePrompt] = useState(null);

  // ── Printing ───────────────────────────────────────────────────────────────
  // copies:2 + autoTag = the zero-prompt print of proposal §2.6. No receipt overrides:
  // a pending receipt is goods-only, which is exactly what V2 charges (see posMath.js).
  const [printOrder, setPrintOrder] = useState(null);
  const printer = usePrintReceipt(
    printOrder,
    {},
    (updated) => {
      setSavedOrder((cur) => {
        if (!cur) return cur;
        const matches = (cur.receipt_number && cur.receipt_number === updated.receipt_number) || (cur.id && cur.id === updated.id);
        return matches ? { ...cur, ...updated } : cur;
      });
      setPrintOrder((cur) => {
        if (!cur) return cur;
        const matches = (cur.receipt_number && cur.receipt_number === updated.receipt_number) || (cur.id && cur.id === updated.id);
        return matches ? { ...cur, ...updated } : cur;
      });
      refreshCounts();
    },
    {},
    { copies: 2, autoTag: true }
  );

  const requestPrint = (order) => {
    setPrintOrder(order);
    printer.handlePrint(order, 2);
  };

  // ── Data load ──────────────────────────────────────────────────────────────

  useEffect(() => {
    // D16 — the tablet sells only what it already holds. With the switch on,
    // loadCatalogue() tries the server first (and quietly refreshes the held copy on
    // success) and silently falls back to that held copy when the server cannot be
    // reached — no staleness warning, nothing shown. With the switch off this is
    // unchanged: the same direct fetch as always.
    if (V25_OFFLINE_CORE) {
      loadCatalogue()
        .then(({ products, customers }) => {
          setProducts(products.filter((p) => p.is_active));
          setCustomers(customers.filter((c) => c.is_active));
        })
        .catch(() => addToast('Failed to load the catalogue.', 'error'))
        .finally(() => setLoading(false));
    } else {
      Promise.all([api.get('/products'), api.get('/customers')])
        .then(([prods, custs]) => {
          setProducts(prods.filter((p) => p.is_active));
          setCustomers(custs.filter((c) => c.is_active));
        })
        .catch(() => addToast('Failed to load the catalogue.', 'error'))
        .finally(() => setLoading(false));
    }
    refreshCounts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Quiet background refresh of the held catalogue (D16) while the POS stays open —
  // no loading state, no error surfaced, just a newer copy to sell from next time.
  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    const interval = setInterval(() => {
      loadCatalogue()
        .then(({ products, customers, fromCache }) => {
          if (fromCache) return; // still blind — nothing newer to adopt
          setProducts(products.filter((p) => p.is_active));
          setCustomers((prev) => {
            const pendingLocal = prev.filter((c) => String(c.id).startsWith('local-'));
            const fresh = customers.filter((c) => c.is_active);
            const freshIds = new Set(fresh.map((c) => String(c.id)));
            return [...fresh, ...pendingLocal.filter((c) => !freshIds.has(String(c.id)))];
          });
        })
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // D6 — possible-double parked orders (same customer/channel/goods total, both still
  // pending, more than one receipt number): count only, so the History chip (which
  // does the actual flagging) has something to point the History button's badge at.
  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    let mounted = true;
    const check = () => {
      api.get('/orders?status=pending')
        .then((rows) => { if (mounted) setDoubleCount(countPossibleDoubleOrders(rows)); })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Badge counts. Unprinted count covers all pending orders whose receipt was
  // never confirmed printed, matching History's default All Time view. Draft count
  // is the D6 union: the server's drafts plus this device's own not-yet-synced
  // local parks, minus any local one that has since synced (matched by receipt
  // number, same dedup shape POSHistoryModal already uses for local receipts).
  function refreshCounts() {
    if (V25_OFFLINE_CORE) {
      listReceipts()
        .then((receipts) => {
          const unprinted = receipts.filter(
            (o) => o.status === 'pending' && !o.pending_receipt_printed_at
          ).length;
          setUnprintedCount(unprinted);
        })
        .catch(() => {});

      listLocalParkedOrders()
        .then((localDrafts) => {
          api.get('/orders?status=draft')
            .then((serverDrafts) => setDraftCount(mergeParkedOrders(serverDrafts, localDrafts).length))
            .catch(() => setDraftCount(localDrafts.length)); // blind: local count only
        })
        .catch(() => {});
    } else {
      api.get('/orders?status=draft')
        .then((rows) => setDraftCount(rows.length))
        .catch(() => {});
    }

    api.get('/orders?status=pending')
      .then((rows) => {
        if (!V25_OFFLINE_CORE) {
          setUnprintedCount(rows.filter((o) => !o.pending_receipt_printed_at).length);
        }
      })
      .catch(() => {});
  }

  const selectedCustomer = customers.find((c) => String(c.id) === String(customerId)) ?? null;

  // Custom prices for the picked customer + channel (wholesaler, discounted, markup, unassigned).
  useEffect(() => {
    if (!customerId || !['wholesaler', 'discounted', 'markup', 'unassigned'].includes(selectedCustomer?.customer_type)) {
      setCustomPrices({});
      return;
    }
    if (String(customerId).startsWith('local-')) {
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

  const orderQty = useMemo(() => {
    const map = {};
    items.forEach((i) => { map[i.product_id] = (map[i.product_id] || 0) + Number(i.quantity); });
    return map;
  }, [items]);

  // Tapping a card adds half a case; holding it repeats, same as the −/+ on a line.
  const addProduct = (product) => {
    if (mode === 'saved') return;
    setItems((prev) => {
      const existing = prev.find((i) => i.product_id === String(product.id));
      if (existing) {
        return prev.map((i) => i._key === existing._key
          ? { ...i, quantity: roundQty(Number(i.quantity) + 0.5) }
          : i);
      }
      return [
        {
          _key:             `${product.id}-${Date.now()}`,
          product_id:       String(product.id),
          product_name:     product.name,
          sku:              product.sku || '',
          unit:             product.unit,
          quantity:         0.5,
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

  // Draft starts the moment a customer is chosen. Online: unchanged (D6) — the exact
  // same early POST the app has always made. Blind, with the switch on, that POST
  // cannot reach the server, so the draft parks locally instead (D6) — the outbox and
  // local store the receipts already use (D17), not a second mechanism. `draftId`
  // then holds either a real row id (online) or the receipt number issued for the
  // local park (offline) — every order route already resolves both forms
  // (resolveOrderId in server/src/routes/orders.js), so nothing downstream needs to
  // know which kind it is looking at.
  useEffect(() => {
    if (mode !== 'build' || !customerId || draftId || creatingDraftRef.current) return;
    creatingDraftRef.current = true;
    setDraftStatus('saving');
    const creating = api.post('/orders', { ...orderBody(), status: 'draft' });
    draftPromiseRef.current = creating;
    creating
      .then((created) => { setDraftId(created.id); setDraftStatus('saved'); refreshCounts(); })
      .catch(async (err) => {
        if (V25_OFFLINE_CORE && !err?.status) {
          // A genuine network failure, not a validation error — park locally.
          try {
            const activeProfileKey = await api.getActiveProfile();
            const { receipt_number } = await parkOrderLocalFirst({
              customer: selectedCustomer, orderType, notes, adjustment, items,
              profileKey: activeProfileKey,
            });
            setDraftId(receipt_number);
            setDraftStatus('saved');
            refreshCounts();
            return;
          } catch (_) { /* fall through to idle below */ }
        }
        creatingDraftRef.current = false;
        draftPromiseRef.current = null;
        setDraftStatus('idle');
      });
  }, [mode, customerId, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The draft payload carries no adjustment — it lives on its own endpoint — so park it
  // explicitly, or a resumed draft comes back with its discount silently dropped.
  const saveDraftAdjustment = async (id) => {
    const value  = Number(adjustment.value) || 0;
    const reason = adjustment.reason.trim();
    if (value === lastSavedAdjRef.current.value && reason === lastSavedAdjRef.current.reason) return;
    if (value !== 0 && !reason) return;   // the endpoint 400s on a non-zero adjustment with no reason
    await api.patch(`/orders/${id}/adjustment`, { adjustment: value, adjustment_reason: reason });
    lastSavedAdjRef.current = { value, reason };
  };

  // Debounced auto-save of the live order onto the draft. Paused while the review
  // modal is up, so no stray PATCH can race the finalize behind it.
  //
  // A string draftId is a locally parked draft (D6, see the effect above). While it
  // is still only local, the edit updates the outbox record in place — no network
  // needed. Once it has synced (isDraftUnsynced turns false, because drainOutbox
  // removed the record), later edits PATCH the real row the same way any other order
  // is addressed once it exists — by its receipt number. A numeric draftId is the
  // pre-2.5 online path and is untouched; a mid-edit connectivity loss on THAT path
  // behaves exactly as it always has (silently retried on the next debounce tick),
  // since the local-first Confirm & Print always succeeds regardless (D2).
  useEffect(() => {
    if (mode !== 'build' || !draftId || saving || reviewOpen) return;
    setDraftStatus('saving');
    const t = setTimeout(async () => {
      try {
        if (V25_OFFLINE_CORE && typeof draftId === 'string' && (await isDraftUnsynced(draftId))) {
          const activeProfileKey = await api.getActiveProfile();
          await updateLocalDraft({
            receiptNumber: draftId, orderType, notes, items, adjustment,
            profileKey: activeProfileKey,
          });
          lastSavedAdjRef.current = {
            value: Number(adjustment.value) || 0,
            reason: adjustment.reason.trim(),
          };
        } else {
          await api.patch(`/orders/${draftId}`, orderBody());
          await saveDraftAdjustment(draftId);
        }
        setDraftStatus('saved');
      } catch (_) {
        setDraftStatus('idle');
      }
    }, 800);
    return () => clearTimeout(t);
  }, [mode, draftId, saving, reviewOpen, customerId, orderType, notes, items, adjustment]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save / update ──────────────────────────────────────────────────────────

  const validate = () => {
    const e = {};
    if (mode === 'build' && !customerId) e.customer = 'Pick a customer first.';
    if (items.length === 0) e.items = 'Add at least one product.';
    else if (items.some((i) => !Number(i.quantity))) e.items = 'Every line needs a quantity.';
    else if (items.some((i) => i.unit_price === '' || Number.isNaN(Number(i.unit_price))))
      e.items = 'Every line needs a price per case.';
    else if (items.some((i) => Number(i.unit_price) < 0))
      e.items = 'A price per case cannot be negative.';
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

  // Save Order: flush the cart onto the draft and review it *before* anything is
  // committed. Nothing is finalized and no stock moves until Confirm & Print, so
  // backing out of the review costs nothing — same shape as V1's draft flow.
  const handleReview = async () => {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) return;

    if (V25_OFFLINE_CORE) {
      const adjVal = Number(adjustment.value) || 0;
      const adjReason = adjustment.reason?.trim() || '';
      const totals = orderTotals(items, adjVal);

      const reviewObj = {
        id: draftId || null,
        // A local park (D6) identifies itself by receipt number, not a row id — see
        // orderRef() and POSReviewModal's header.
        receipt_number: typeof draftId === 'string' ? draftId : null,
        customer_id: selectedCustomer?.id && !String(selectedCustomer.id).startsWith('local-') ? Number(selectedCustomer.id) : selectedCustomer?.id,
        customer_name: selectedCustomer?.name || 'Customer',
        customer_address: selectedCustomer?.address || null,
        customer_phone: selectedCustomer?.phone || null,
        customer_type: selectedCustomer?.customer_type || 'regular',
        order_type: orderType,
        notes: notes.trim() || null,
        adjustment: adjVal,
        adjustment_reason: adjVal !== 0 ? adjReason : null,
        items: items.map((i, idx) => ({
          id: i.id || idx + 1,
          product_id: Number(i.product_id),
          product_name: i.product_name,
          sku: i.sku || '',
          unit: i.unit || 'cs',
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price),
          unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
          units_per_case: Number(i.units_per_case) || 1,
          is_price_overridden: Boolean(i._priceEdited),
        })),
        total_amount: totals.goods,
      };
      setReviewOrder(reviewObj);
      setReviewOpen(true);
      return;
    }

    setSaving(true);
    try {
      // Tapping Save within the first second of picking a customer can land while the
      // draft POST is still in flight — wait for it rather than creating a second order.
      let openDraftId = draftId;
      if (!openDraftId && draftPromiseRef.current) {
        try { openDraftId = (await draftPromiseRef.current).id; } catch (_) { openDraftId = null; }
      }
      if (!openDraftId) {
        const created = await api.post('/orders', { ...orderBody(), status: 'draft' });
        openDraftId = created.id;
        creatingDraftRef.current = true;
        setDraftId(openDraftId);
      }

      await api.patch(`/orders/${openDraftId}`, finalPayload());
      await saveDraftAdjustment(openDraftId);
      setDraftStatus('saved');

      const full = await api.get(`/orders/${openDraftId}`);
      setReviewOrder(full);
      setReviewOpen(true);
      refreshCounts();
    } catch (err) {
      addToast(err.message || 'Failed to open the order review.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Confirm & Print: the draft becomes Created (backend `pending`), stock deducts
  // server-side and the receipt prints. This is the first irreversible step.
  const handleConfirmPrint = async () => {
    const target = reviewOrder;
    if (!target) return;

    // Snapshot hand-edited ("dirty") lines against priceFor() before committing
    const dirtyItems = items.reduce((acc, i) => {
      const product = products.find((p) => String(p.id) === i.product_id);
      if (product && Number(i.unit_price) !== priceFor(product)) {
        acc.push({
          product_id:   Number(i.product_id),
          product_name: product.name,
          sku:          product.sku || '',
          unit_price:   Number(i.unit_price),
        });
      }
      return acc;
    }, []);

    setSaving(true);
    try {
      if (V25_OFFLINE_CORE) {
        const activeProfileKey = await api.getActiveProfile();
        // The draft this same POS flow created earlier (see the early-draft effect
        // above) — either a real server row (online) or a locally parked one (D6).
        // The local-first save below makes it a second, orphaned copy of this order
        // (piece 3 regression fix): it must not survive as a draft.
        const orphanedDraftRef = draftId;
        const saved = await saveOrderLocalFirst({
          customer: selectedCustomer,
          orderType,
          notes,
          adjustment,
          items,
          profileKey: activeProfileKey,
          addToast,
        });

        setSavedOrder(saved);
        setDraftId(null);
        setDraftStatus('idle');
        creatingDraftRef.current = false;
        draftPromiseRef.current = null;
        addToast(`Order ${orderRef(saved)} created.`, 'success');

        if (orphanedDraftRef !== null && orphanedDraftRef !== undefined) {
          cleanupOrphanedDraft({ draftRef: orphanedDraftRef, profileKey: activeProfileKey }).catch(() => {});
        }

        setReviewOpen(false);
        setReviewOrder(null);
        requestPrint(saved);
        refreshCounts();

        if (dirtyItems.length && selectedCustomer && !String(selectedCustomer.id).startsWith('local-')) {
          setPriceSavePrompt({
            step: 'first',
            orderId: saved.receipt_number,
            customer: selectedCustomer,
            orderType,
            dirty: dirtyItems,
            busy: false,
          });
        }
        return;
      }

      await api.post(`/orders/${target.id}/finalize`, {});
      await syncAdjustment(target.id, {
        adjustment:        lastSavedAdjRef.current.value,
        adjustment_reason: lastSavedAdjRef.current.reason,
      });

      const full = await api.get(`/orders/${target.id}`);
      setSavedOrder(full);
      setDraftId(null);
      setDraftStatus('idle');
      creatingDraftRef.current = false;
      draftPromiseRef.current = null;
      addToast(`Order ${orderRef(full)} created.`, 'success');

      setReviewOpen(false);
      setReviewOrder(null);
      requestPrint(full);
      refreshCounts();

      // Offer to save custom prices if any were hand-edited
      if (dirtyItems.length && selectedCustomer) {
        setPriceSavePrompt({
          step: 'first',
          orderId: target.id,
          customer: selectedCustomer,
          orderType,
          dirty: dirtyItems,
          busy: false,
        });
      }
    } catch (err) {
      if (!checkIsOnline()) {
        triggerOfflineAdvisory({ addToast }).catch(() => {});
      }
      addToast(err.message || 'Failed to create the order.', 'error');
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

    // Snapshot hand-edited ("dirty") lines against priceFor() before submitting
    const dirtyItems = items.reduce((acc, i) => {
      const product = products.find((p) => String(p.id) === i.product_id);
      if (product && Number(i.unit_price) !== priceFor(product)) {
        acc.push({
          product_id:   Number(i.product_id),
          product_name: product.name,
          sku:          product.sku || '',
          unit_price:   Number(i.unit_price),
        });
      }
      return acc;
    }, []);

    setSaving(true);
    try {
      if (V25_OFFLINE_CORE && editOrder?.receipt_number && (await isOrderUnsynced(editOrder.receipt_number))) {
        const updated = await updateLocalOrder({
          order: editOrder,
          items,
          notes,
          adjustment,
          profileKey: await api.getActiveProfile(),
        });
        addToast(`Order ${orderRef(editOrder)} updated.`, 'success');
        setSavedOrder(updated);
        setEditOrder(null);
        buildStash.current = null;
        refreshCounts();
        return;
      }

      const { customer_id, order_type, ...editable } = finalPayload();
      await api.patch(`/orders/${editOrder.id || editOrder.receipt_number}`, editable);
      await syncAdjustment(editOrder.id || editOrder.receipt_number, editOrder);
      addToast(`Order ${orderRef(editOrder)} updated.`, 'success');
      const editedOrderId = editOrder.id || editOrder.receipt_number;
      const updatedFull = await api.get(`/orders/${editedOrderId}`);
      setSavedOrder(updatedFull);
      setEditOrder(null);
      buildStash.current = null;
      refreshCounts();

      // Straight back to the print stage — the review modal is for drafts only, and this
      // order already exists. Read it back with History's 👁️ View if needed.

      if (dirtyItems.length && selectedCustomer) {
        setPriceSavePrompt({
          step: 'first',
          orderId: editedOrderId,
          customer: selectedCustomer,
          orderType,
          dirty: dirtyItems,
          busy: false,
        });
      }
    } catch (err) {
      addToast(err.message || 'Failed to update the order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Save-custom-price prompt handlers ──────────────────────────────────────
  const declinePriceSave = () => {
    setPriceSavePrompt(null);
  };

  const acceptFirstPrompt = () => {
    if (['wholesaler', 'discounted', 'markup', 'unassigned'].includes(priceSavePrompt.customer.customer_type)) {
      persistPriceSave(false);
    } else {
      setPriceSavePrompt((p) => ({ ...p, step: 'second' }));
    }
  };

  const persistPriceSave = async (targetType) => {
    setPriceSavePrompt((p) => ({ ...p, busy: true }));
    try {
      if (targetType) {
        const newType = typeof targetType === 'string' ? targetType : 'unassigned';
        await api.patch(`/customers/${priceSavePrompt.customer.id}`, {
          customer_type:   newType,
          conversion_note: `custom price saved from order #${priceSavePrompt.orderId}`,
        });
        setCustomers((prev) =>
          prev.map((c) =>
            c.id === priceSavePrompt.customer.id ? { ...c, customer_type: newType } : c
          )
        );
      }

      await Promise.all(
        priceSavePrompt.dirty.map((d) =>
          api.post(`/customers/${priceSavePrompt.customer.id}/prices`, {
            product_id:        d.product_id,
            custom_unit_price: d.unit_price,
            order_type:        priceSavePrompt.orderType,
          })
        )
      );

      addToast('Custom price saved.', 'success');

      // Refresh custom prices map in POS
      const refreshedPrices = await api.get(
        `/customers/${priceSavePrompt.customer.id}/prices?order_type=${priceSavePrompt.orderType}`
      );
      const map = {};
      refreshedPrices.forEach((p) => { map[p.product_id] = p; });
      setCustomPrices(map);
    } catch (err) {
      addToast(err.message || 'Failed to save custom price.', 'error');
    } finally {
      setPriceSavePrompt(null);
    }
  };

  // ── Order lifecycle ────────────────────────────────────────────────────────

  const blankOrder = () => {
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
    lastSavedAdjRef.current = { value: 0, reason: '' };
  };

  const startNewOrder = () => {
    setSavedOrder(null);
    setPrintOrder(null);
    blankOrder();
  };

  const clearOrder = async () => {
    const id = draftId;
    blankOrder();
    if (id) {
      try {
        if (V25_OFFLINE_CORE && typeof id === 'string' && (await isDraftUnsynced(id))) {
          await discardLocalDraft(id);
        } else {
          await api.del(`/orders/${id}`).catch(async (err) => {
            if (V25_OFFLINE_CORE && !err?.status) {
              // Blind, and this draft already exists on the server (or might) —
              // queue the delete so it still lands once the line returns (D6/D13).
              await queueOrderDeletion({ orderRef: id, profileKey: await api.getActiveProfile() });
            }
          });
        }
      } catch (_) { /* draft already gone — nothing to clean up */ }
      refreshCounts();
    }
  };

  const enterEditMode = (order) => {
    // Park whatever is on the order panel so exiting edit mode gives it straight back —
    // including the saved order behind the print buffer, so Edit → Exit from the print
    // stage returns to Print / Review / Edit instead of a blank panel.
    buildStash.current = mode === 'edit'
      ? null
      : {
          customerId, orderType, items, notes, adjustment, draftId, draftStatus,
          savedOrder:   mode === 'saved' ? savedOrder : null,
          lastSavedAdj: lastSavedAdjRef.current,
        };

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

  const location = useLocation();
  useEffect(() => {
    if (location.state?.editOrder) {
      enterEditMode(location.state.editOrder);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Review modal handlers ─────────────────────────────────────────────────
  // The review only ever shows a draft, and the cart it came from is still on the panel
  // behind it, so every way out of it (✕, Escape, backdrop, ✏️ Edit Items) is the same
  // thing: go back to the cart. Nothing is committed, so nothing needs confirming.
  const closeReview = () => {
    setReviewOpen(false);
    setReviewOrder(null);
  };

  // "Draft" — the draft is already saved on the server, so this only clears the screen.
  // It reappears in the Drafts popup, count badge and all.
  const parkReviewedDraft = () => {
    closeReview();
    startNewOrder();
    refreshCounts();
  };

  // "Discard" — the draft never deducted stock and was never a business event, so it is
  // genuinely deleted, exactly like V1's Discard draft (OrderCreateModal handleDiscard).
  // target.id is draftId either way (see handleReview's V25_OFFLINE_CORE branch), so it
  // may be a receipt-number string (a locally parked draft, D6) rather than a row id.
  const discardReviewedDraft = async () => {
    const target = reviewOrder;
    if (!target) return;
    const ref = target.id ?? draftId;
    setConfirmBusy(true);
    try {
      if (V25_OFFLINE_CORE && typeof ref === 'string' && (await isDraftUnsynced(ref))) {
        await discardLocalDraft(ref);
      } else if (ref) {
        await api.del(`/orders/${ref}`).catch(async (err) => {
          if (V25_OFFLINE_CORE && !err?.status) {
            await queueOrderDeletion({ orderRef: ref, profileKey: await api.getActiveProfile() });
          } else {
            throw err;
          }
        });
      }
      addToast('Draft discarded.', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to discard the draft.', 'error');
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
      closeReview();
      startNewOrder();
      refreshCounts();
    }
  };

  // Resume a parked draft: it goes back on the POS in build mode with its draft id, so
  // the debounced auto-save keeps updating that same draft and Save Order finalizes it.
  // Any draft already on screen simply stays a draft — it reappears in the Drafts popup.
  //
  // A locally parked draft (D6, order._outboxId set) only ever carried the bare item
  // shape its outbox payload needs (product_id/quantity/unit_price/…) — no display
  // fields, since nothing else read them until now. Hydrate name/sku/unit from the
  // held catalogue (D16) the same way the cart already prices every line.
  const resumeDraft = (order) => {
    setSavedOrder(null);
    setPrintOrder(null);
    setEditOrder(null);
    buildStash.current = null;
    setCustomerId(String(order.customer_id));
    setOrderType(order.order_type);
    setNotes(order.notes ?? '');
    setAdjustment({
      value:  Number(order.adjustment) ? String(order.adjustment) : '',
      reason: order.adjustment_reason ?? '',
    });
    setItems(order.items.map((i, idx) => {
      const product = order._outboxId
        ? products.find((p) => String(p.id) === String(i.product_id))
        : null;
      return {
        _key:             `${i.id || idx}`,
        product_id:       String(i.product_id),
        product_name:     product ? product.name : i.product_name,
        sku:              (product ? product.sku : i.sku) || '',
        unit:             (product ? product.unit : i.unit) || 'cs',
        quantity:         Number(i.quantity),
        unit_price:       String(Number(i.unit_price)),
        unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
        units_per_case:   Number(i.units_per_case) || 1,
        _priceEdited:     true,   // keep the prices the draft was saved with
      };
    }));
    setDraftId(order.receipt_number || order.id);
    setDraftStatus('saved');
    lastSavedAdjRef.current = {
      value:  Number(order.adjustment) || 0,
      reason: order.adjustment_reason || '',
    };
    creatingDraftRef.current = true;   // this draft exists; don't create another
    draftPromiseRef.current = null;
    setErrors({});
    setDraftsOpen(false);
  };

  // `dropOrderId` — the order just cancelled must not come back on the print buffer.
  const exitEditMode = ({ dropOrderId = null } = {}) => {
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
      lastSavedAdjRef.current = stash.lastSavedAdj ?? { value: 0, reason: '' };
      setSavedOrder(stash.savedOrder && stash.savedOrder.id !== dropOrderId ? stash.savedOrder : null);
      setErrors({});
    } else {
      blankOrder();
    }
  };

  const cancelOrder = async (order) => {
    const orderRefId = order.id || order.receipt_number;
    setConfirmBusy(true);
    try {
      if (V25_OFFLINE_CORE && order.receipt_number && (await isOrderUnsynced(order.receipt_number))) {
        await discardLocalOrder(order.receipt_number);
        addToast(`Order ${orderRef(order)} discarded.`, 'success');
        setConfirm(null);
        if (editOrder?.receipt_number === order.receipt_number || editOrder?.id === order.id) {
          exitEditMode({ dropOrderId: orderRefId });
        }
        if (savedOrder?.receipt_number === order.receipt_number || savedOrder?.id === order.id) {
          startNewOrder();
        }
        refreshCounts();
        return;
      }

      await api.post(`/orders/${orderRefId}/status`, { status: 'cancelled' });
      addToast(`Order ${orderRef(order)} cancelled — stock restored.`, 'success');
      setConfirm(null);
      if (editOrder?.id === order.id || editOrder?.receipt_number === order.receipt_number) {
        exitEditMode({ dropOrderId: orderRefId });
      }
      if (savedOrder?.id === order.id || savedOrder?.receipt_number === order.receipt_number) {
        startNewOrder();
      }
      refreshCounts();
    } catch (err) {
      addToast(err.message || 'Failed to cancel the order.', 'error');
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleSelectCustomer = (customer) => {
    if (!customer) {
      setCustomerId('');
      return;
    }
    setCustomers((prev) => (prev.some((c) => String(c.id) === String(customer.id)) ? prev : [...prev, customer]));
    setCustomerId(String(customer.id));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-3 pb-3 pt-2">
      {/* The only full-width row is the amber banner, and only while editing — the
          catalogue and the order panel otherwise start straight under the nav bar.
          History and the print alert ride along the search row (headerActions). */}
      {mode === 'edit' && (
        <div className="shrink-0">
          <AmberEditHeader order={editOrder} />
        </div>
      )}

      {/* Catalogue + order panel */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem]">
        <POSProductGrid
          products={products}
          orderQty={orderQty}
          onAdd={addProduct}
          priceFor={priceFor}
          disabled={mode === 'saved'}
          headerActions={
            <>
              <button
                type="button"
                onClick={() => setDraftsOpen(true)}
                aria-label={`Drafts — ${draftCount} parked`}
                className={TOP_BTN}
              >
                📝 Drafts
                {draftCount > 0 && (
                  <span className={`${COUNT_BADGE} bg-v2-accent-strong text-white`} aria-hidden="true">
                    {draftCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                aria-label={`History — ${unprintedCount} order${unprintedCount === 1 ? '' : 's'} not printed${doubleCount ? `, ${doubleCount} possibly doubled` : ''}`}
                className={TOP_BTN}
              >
                🕘 History
                {unprintedCount > 0 && (
                  <span className={`${COUNT_BADGE} bg-amber-500 text-amber-950`} aria-hidden="true">
                    {unprintedCount}
                  </span>
                )}
                {doubleCount > 0 && (
                  <span
                    className={`${COUNT_BADGE} bg-red-600 text-white`}
                    aria-hidden="true"
                    title={`${doubleCount} possibly doubled order${doubleCount === 1 ? '' : 's'}`}
                  >
                    ⚠️{doubleCount}
                  </span>
                )}
              </button>
            </>
          }
        />

        <POSOrderPanel
          mode={mode}
          customers={customers}
          selectedCustomer={selectedCustomer}
          onSelectCustomer={handleSelectCustomer}
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
          editOrderId={editOrder?.id || editOrder?.receipt_number}
          editOrder={editOrder}
          saving={saving}
          printing={printer.printing}
          onSave={handleReview}
          onUpdate={handleUpdate}
          onPrint={() => requestPrint(savedOrder)}
          onEditSaved={() => {
            enterEditMode(savedOrder);
          }}
          onNewOrder={startNewOrder}
          onClearOrder={clearOrder}
          onCancelOrder={() => setConfirm({ kind: 'cancel', order: editOrder })}
          onExitEdit={exitEditMode}
        />
      </div>

      {/* Pre-Print Order Review Modal (proposal & Edit ⇄ Review Loop) */}
      {reviewOpen && reviewOrder && (
        <POSReviewModal
          order={reviewOrder}
          products={products}
          customPrices={customPrices}
          saving={saving}
          onConfirm={handleConfirmPrint}
          onEdit={closeReview}
          onClose={closeReview}
          onDiscard={() => setConfirm({ kind: 'discard-draft', order: reviewOrder })}
          onDraft={parkReviewedDraft}
        />
      )}

      {draftsOpen && (
        <POSDraftsModal
          customers={customers}
          onClose={() => { setDraftsOpen(false); refreshCounts(); }}
          onResume={resumeDraft}
          onChanged={refreshCounts}
        />
      )}

      {historyOpen && (
        <POSHistoryModal
          products={products}
          onClose={() => { setHistoryOpen(false); refreshCounts(); }}
          onChanged={refreshCounts}
          onEdit={enterEditMode}
          onReprint={(order) => { setHistoryOpen(false); requestPrint(order); }}
        />
      )}

      {confirm?.kind === 'discard-draft' && (
        <POSConfirm
          title="Discard this draft?"
          confirmLabel="Yes, discard it"
          cancelLabel="Keep it"
          danger
          loading={confirmBusy}
          onConfirm={discardReviewedDraft}
          onClose={() => setConfirm(null)}
        >
          Nothing has been created yet and no stock has moved, so this simply deletes the
          draft{confirm.order?.customer_name ? ` for ${confirm.order.customer_name}` : ''}.
          It cannot be undone.
        </POSConfirm>
      )}

      {confirm?.kind === 'cancel' && (
        <POSConfirm
          title={`Cancel order #${confirm.order.id}?`}
          confirmLabel="Yes, cancel the order"
          cancelLabel="Keep it"
          danger
          loading={confirmBusy}
          onConfirm={() => cancelOrder(confirm.order)}
          onClose={() => setConfirm(null)}
        >
          This voids the order for <strong className="text-v2-text">{confirm.order.customer_name}</strong> and
          puts the stock back. It cannot be undone.
        </POSConfirm>
      )}

      {/* Save Custom Price prompt (proposal §4 & save-custom-price-prompt.md) */}
      <POSSavePriceModal
        prompt={priceSavePrompt}
        onAcceptFirst={acceptFirstPrompt}
        onConfirmConvert={(targetType) => persistPriceSave(targetType || 'unassigned')}
        onDecline={declinePriceSave}
      />

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
