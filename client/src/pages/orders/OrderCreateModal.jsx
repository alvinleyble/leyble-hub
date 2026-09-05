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
import {
  saveOrderLocalFirst, updateLocalOrder, cleanupOrphanedDraftDirect,
  parkOrderLocalFirst, updateLocalDraft, discardLocalDraft,
  enqueue, drainOutbox, loadCustomerPrices, loadCatalogue, queuedCustomersFromOutbox,
  checkIsOnline, ref,
} from '../../offline/index.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-11 px-3 border border-slate-300 rounded-lg text-sm text-slate-900 bg-white
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const customerMatches = (c, q) => {
  const s = q.trim().toLowerCase();
  return s === '' ? false : c.name.toLowerCase().includes(s);
};

// G29 — a customer quick-created offline carries a temporary id until its real POST
// /customers drains and its row exists server-side (D5). Any code path that would hit
// GET/POST against that id must be skipped, not attempted and swallowed.
const isLocalCustomer = (id) => typeof id === 'string' && id.startsWith('local-');

// D3.1 (phone-responsive-layout.md follow-up) — the customer picker + order type toggle
// render in two places: their original spot in the order panel (tablet/lg+, untouched)
// and a collapsible header pinned above the product grid (phone width only). Shared here
// so the two call sites can't drift; each supplies its own wrapper and onSelect behavior.
function CustomerAndOrderTypeFields({
  activeCustomers, selectedCustomer, onSelectCustomer, onQueryChange,
  onCreateCustomer, creatingCustomer, customPrices, orderType, setOrderType,
  isEdit, customerError,
}) {
  return (
    <>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Customer</p>
        <Combobox
          items={activeCustomers}
          match={customerMatches}
          value={selectedCustomer ?? null}
          displayValue={(c) => c.name}
          minChars={1}
          onSelect={onSelectCustomer}
          onQueryChange={onQueryChange}
          onCreate={onCreateCustomer}
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
        {customerError && <p className="text-xs text-red-600 mt-1 font-medium">{customerError}</p>}
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
    </>
  );
}

export default function OrderCreateModal({ onClose, onSaved, editOrder = null, offlineUnsynced = false }) {
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

  // D3 (phone-responsive-layout.md) — below `lg` the order/cart panel becomes a bottom
  // sheet, collapsed to a summary bar by default. No effect at `lg`+, where the panel
  // renders exactly as it always has (D2).
  const [sheetExpanded, setSheetExpanded] = useState(false);

  // D3.1 — below `lg`, the customer/order-type header pinned above the grid starts open
  // and auto-collapses the moment a customer is picked; `customerHeaderPinnedOpen` is only
  // the manual "reopen it anyway" override from tapping the collapsed summary. Derived, not
  // its own source of truth, so a prefilled editOrder customer starts collapsed too and
  // clearing the query re-opens it without any extra wiring.
  const [customerHeaderPinnedOpen, setCustomerHeaderPinnedOpen] = useState(false);
  const customerHeaderOpen = !customerId || customerHeaderPinnedOpen;

  // ── Adjustment ────────────────────────────────────────────────────────────
  const [adjExpanded, setAdjExpanded] = useState(isRealEdit && Number(editOrder?.adjustment) !== 0);
  const [adjValue, setAdjValue]       = useState(isRealEdit && Number(editOrder?.adjustment) ? String(editOrder.adjustment) : '');
  const [adjReason, setAdjReason]     = useState(isRealEdit ? (editOrder?.adjustment_reason ?? '') : '');

  // ── Draft auto-save state ──────────────────────────────────────────────────
  // A draft's reference is either a server row id (the ordinary online early POST) or a
  // device-issued receipt number (a draft parked locally because the line was down).
  // `draftLocalRef` is which of the two, and it decides every later draft operation.
  const draftRefOf = (o) => (o?.id ?? o?.receipt_number ?? null);
  const [draftId, setDraftId]                     = useState(isDraftResume ? draftRefOf(editOrder) : null);
  const [draftStatus, setDraftStatus]             = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingReset, setConfirmingReset]     = useState(false);
  const creatingDraftRef                          = useRef(false);
  // Ref copies for synchronous access in handleSubmit (avoids stale-closure issues with state)
  const draftIdRef         = useRef(isDraftResume ? draftRefOf(editOrder) : null);
  const draftLocalRef      = useRef(Boolean(isDraftResume && editOrder?._local));
  const draftPromiseRef    = useRef(null); // in-flight draft creation promise
  const autoSaveTimerRef   = useRef(null); // handle for the debounced PATCH timer

  // ── Save-custom-price prompt ───────────────────────────────────────────────
  const [priceSavePrompt, setPriceSavePrompt] = useState(null);

  // ── Mis-tagged-customer nudge ──────────────────────────────────────────────
  // A `regular` customer holding saved prices is a contradiction the owners want to see and
  // resolve: under ADR 0009 those prices are live either way, so the tag is simply lying about
  // the account. This prompt fires on selection, before the order is built — distinct from the
  // "Save Custom Price?" prompt above, which fires at save time about a price typed in THIS
  // order. Both can appear in one order session; they are independent.
  //
  // Deliberately has no dismissal memory (captain's explicit instruction): Skip drops it for
  // this selection only, and picking the same customer again asks again. It stops when the tag
  // is corrected, which is the point.
  const [tagPrompt, setTagPrompt] = useState(null);

  // Slice 3.2 — loadCatalogue() instead of three bare api.get calls.
  //
  // This was the single most damaging offline gap in the app: `loadCatalogue()` had
  // been written in offline/catalogue.js and never called from here, so tapping
  // "+ New Order" while blind showed "Failed to load form data.", an empty customer
  // dropdown and a blank product grid — order taking, the one thing the tablet exists
  // to do during an outage, was impossible. loadCatalogue tries the server first and
  // quietly refreshes the held copy on success, and falls back to that held copy when
  // it can't be reached, so there is one code path online and offline (D2/D16).
  // Personnel comes back with it too — V3.5 removed the Driver/Helper picker UI, but
  // an existing order's assigned personnel still needs their full_name resolved here
  // so it round-trips unchanged on save (see assignedPersonnel below).
  useEffect(() => {
    Promise.all([loadCatalogue(), queuedCustomersFromOutbox()])
      .then(([{ products: prods, customers: served, personnel: pers, fromCache }, queued]) => {
        // Slice 3.2 — a customer added from the Customers directory while offline is
        // queued in the outbox, not on the server, so the catalogue above cannot know
        // about her. Merge those in (same `local-<outboxId>` shape the inline
        // quick-create below produces) or she would be unpickable until the line
        // returns — which is the whole point of having added her during an outage.
        let custs = [...queued, ...served];

        // G28 — editing an order still queued for a still-local customer (G29):
        // that customer has no server row yet, so GET /customers never returns it.
        // Without this, the picker would find nothing for editOrder.customer_id and
        // render blank, even though the order plainly belongs to someone.
        if (editOrder?.customer_id && isLocalCustomer(editOrder.customer_id)
            && !custs.some((c) => String(c.id) === String(editOrder.customer_id))) {
          custs = [...custs, {
            id: editOrder.customer_id,
            name: editOrder.customer_name,
            address: editOrder.customer_address,
            phone: editOrder.customer_phone,
            customer_type: editOrder.customer_type || 'regular',
            is_active: true,
          }];
        }
        setCustomers(custs);
        setProducts(prods);
        setActivePersonnel(pers);

        // The one corner D16 accepts: a device that has never synced and has no line
        // now holds nothing to sell. Say so plainly rather than showing a blank grid.
        if (fromCache && prods.length === 0) {
          addToast('Offline and this device has no catalogue yet — connect once to set it up.', 'error');
        }
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
  //
  // Offline pricing gap fix: loadCustomerPrices (client/src/offline/catalogue.js) tries
  // the live endpoint first and quietly refreshes the device's held copy of this
  // customer's rates on success; when the tablet is offline or the fetch fails, it
  // falls back to whatever this device last cached for this customer/order_type, so an
  // agreed rate still applies instead of silently defaulting to base price.
  useEffect(() => {
    // G29 — a still-local customer has no server prices to fetch (and no route to
    // fetch them from, since it has no real id yet); default to base wholesale prices.
    if (!customerId || isLocalCustomer(customerId)) {
      setCustomPrices({});
      return;
    }
    let cancelled = false;
    loadCustomerPrices(customerId, orderType)
      .then(({ prices }) => {
        if (cancelled) return;
        const map = {};
        prices.forEach((p) => { map[p.product_id] = p; });
        setCustomPrices(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [customerId, orderType]);

  // Does this customer hold ANY saved price, on either channel? `/customers/:id/prices` is
  // scoped to one order_type, and the tag is wrong regardless of which channel the rows sit on,
  // so this asks both rather than reusing the single-channel response loaded above. Routed
  // through loadCustomerPrices so the nudge still works from the cached copy when offline,
  // instead of failing silently like the live-only fetch it replaced.
  const hasAnySavedPrice = async (id) => {
    // G29 — a still-local customer cannot have saved prices yet (there is nothing
    // server-side to have saved them against), so the mis-tagged-customer nudge below
    // must never even ask.
    if (isLocalCustomer(id)) return false;
    const [delivery, pickup] = await Promise.all([
      loadCustomerPrices(id, 'delivery'),
      loadCustomerPrices(id, 'pickup'),
    ]);
    return hasCustomPricing(delivery.prices) || hasCustomPricing(pickup.prices);
  };

  // Fires on selection, not on order-type switches — hence customerId alone in the deps. Skipped
  // while editing a live order: that customer was tagged long before this order existed, and the
  // nudge belongs to the create flow.
  useEffect(() => {
    if (isRealEdit || !customerId) { setTagPrompt(null); return; }
    const customer = customers.find((c) => String(c.id) === String(customerId));
    if (customer?.customer_type !== 'regular') { setTagPrompt(null); return; }

    let cancelled = false;
    hasAnySavedPrice(customerId)
      .then((has) => {
        if (!cancelled && has) setTagPrompt({ customer, busy: false });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [customerId, customers, isRealEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeCustomers = customers.filter((c) => c.is_active);
  const activeProducts  = products.filter((p) => p.is_active);

  // Quick-add a customer straight from the order's customer picker.
  //
  // G29/G13 — V1's picker already had inline quick-create; what it lacked was an
  // offline path (unlike V2's POSCustomerSearch, this called api.post directly and
  // failed outright when the line was down). Unconditional, matching G27's
  // saveOrderLocalFirst: one code path, online or offline, every day — queue POST
  // /customers in the outbox and hand back a `local-<outboxId>` customer the rest of
  // the modal already knows to treat specially (isLocalCustomer above).
  const handleCreateCustomer = async (name) => {
    setCreatingCustomer(true);
    try {
      const profileKey = await api.getActiveProfile();
      const rec = await enqueue({
        entityType: 'customer',
        endpoint: '/customers',
        method: 'POST',
        payload: { name, customer_type: 'regular' },
        profileKey,
      });
      const localCustomer = {
        id: `local-${rec.id}`,
        _outboxId: rec.id,
        name,
        customer_type: 'regular',
        is_active: true,
      };
      setCustomers((prev) => [...prev, localCustomer]);
      setCustomerId(String(localCustomer.id));
      addToast(`${localCustomer.name} added as Customer.`, 'success');
      drainOutbox().catch(() => {});
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

  // The display half of a locally parked draft (offline/parkedOrders.js): the customer
  // and product names the POST body has no field for, and without which a resumed
  // local draft would come back as nameless lines.
  const draftDisplay = () => ({
    customer_name: selectedCustomer?.name || '',
    customer_type: selectedCustomer?.customer_type || 'regular',
    items: items.filter((i) => i.product_id).map((i) => ({
      product_id:             Number(i.product_id),
      product_name:           i.product_name,
      sku:                    i.sku || '',
      unit:                   i.unit || 'cs',
      requires_bottle_return: Boolean(i.requires_bottle_return || Number(i.unit_deposit_fee) > 0),
    })),
  });

  const draftAdjustment = () => ({ value: Number(adjValue) || 0, reason: adjReason.trim() });

  // A thrown error with no HTTP status never reached the server — the same rule the
  // outbox drains by (isNetworkFailure in offline/outbox.js). Only that is an outage;
  // a 4xx is a refusal and must NOT fall back to a local park (parkedOrders.js).
  const isOffline = (err) => !err?.status;

  // Park the draft on this device instead of on the server. Criterion 5.13 — "save as
  // draft" has to work blind — and until Slice 3.2 nothing called
  // parkOrderLocalFirst() at all, so an order drafted during an outage was written
  // nowhere: the early POST below failed, draftId never got set, the debounced save
  // never fired, and closing the modal lost the lot.
  const parkDraftLocally = async () => {
    const { receipt_number } = await parkOrderLocalFirst({
      customer: selectedCustomer ?? (customerId ? { id: customerId } : null),
      orderType,
      notes,
      adjustment: draftAdjustment(),
      items: items.filter((i) => i.product_id),
      display: draftDisplay(),
    });
    draftIdRef.current = receipt_number;
    draftLocalRef.current = true;
    setDraftId(receipt_number);
    setDraftStatus('saved');
    return receipt_number;
  };

  // Create the draft the moment a customer is chosen.
  //
  // G29 — a still-local customer skips the SERVER draft (POST /orders with an
  // unresolved customer_id would be rejected) but no longer skips drafting entirely:
  // parkOrderLocalFirst carries her as the same $ref placeholder a local-first sale
  // does, so the draft queues behind her and resolves when she syncs (D5).
  useEffect(() => {
    if (!isDraftMode || !customerId || draftIdRef.current || creatingDraftRef.current) return;
    creatingDraftRef.current = true;
    setDraftStatus('saving');
    const promise = (isLocalCustomer(customerId)
      ? parkDraftLocally()
      : api.post('/orders', { ...draftBody(), status: 'draft' })
        .then((created) => {
          draftIdRef.current = created.id;
          draftLocalRef.current = false;
          setDraftId(created.id);
          setDraftStatus('saved');
          return created.id;
        })
        .catch((err) => {
          if (!isOffline(err)) throw err;
          return parkDraftLocally();
        }))
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

  // Debounced auto-save on any change once the draft exists.
  //
  // A locally parked draft is rewritten in its outbox record instead of PATCHed — no
  // network, so it saves blind exactly like the rest of the offline path. If it
  // drained while this modal was open, updateLocalDraft throws (its record is gone)
  // and the server now holds it under that receipt number, which every order route
  // resolves (resolveOrderId), so we switch to the ordinary PATCH rather than losing
  // the edit.
  useEffect(() => {
    if (!isDraftMode || !draftId || saving) return;
    setDraftStatus('saving');
    const t = setTimeout(async () => {
      autoSaveTimerRef.current = null;
      try {
        if (draftLocalRef.current) {
          try {
            await updateLocalDraft({
              receiptNumber: draftIdRef.current,
              orderType,
              notes,
              items: items.filter((i) => i.product_id),
              adjustment: draftAdjustment(),
              display: draftDisplay(),
            });
          } catch {
            draftLocalRef.current = false;
            await api.patch(`/orders/${draftIdRef.current}`, draftBody());
          }
        } else {
          await api.patch(`/orders/${draftIdRef.current}`, draftBody());
        }
        setDraftStatus('saved');
      } catch {
        // A server-side draft that cannot be reached keeps whatever it last held; the
        // next change retries with the full body, so nothing is lost once the line is
        // back. (Only a draft STARTED offline can be parked locally — parking one that
        // already has a server row would create a second row on drain.)
        setDraftStatus('idle');
      }
    }, 800);
    autoSaveTimerRef.current = t;
    return () => { clearTimeout(t); if (autoSaveTimerRef.current === t) autoSaveTimerRef.current = null; };
  }, [isDraftMode, draftId, saving, customerId, orderType, notes, items, assignedPersonnel, adjValue, adjReason]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Disposes of whichever early draft this modal is holding, without ever queuing a
  // delete through the outbox (that was rejected PR #41's bug: a throwaway DELETE
  // stuck in front of real order POSTs wedged the "Offline · N waiting" count).
  //
  // A draft parked on this device is simply removed from the outbox — instant, no
  // network. If it had already drained, the server holds it under its receipt number,
  // which the direct DELETE below addresses just as well as a row id; a 404 when it
  // never reached the server is exactly the harmless no-op this is best-effort about.
  const discardDraftRef = async (draftRef) => {
    if (draftRef === null || draftRef === undefined || draftRef === '') return;
    if (draftLocalRef.current) {
      await discardLocalDraft(draftRef).catch(() => {});
    }
    cleanupOrphanedDraftDirect(draftRef);
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

    // Cancel any pending debounced auto-save so it can't race with our explicit save below.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    // G31 — resolve full personnel objects (id, role, full_name) once, for both the
    // local-first save path and the offline-edit path below.
    const personnelWithNames = assignedPersonnel.map((p) => ({
      id: p.id,
      role: p.role,
      full_name: activePersonnel.find((x) => x.id === p.id)?.full_name,
    }));
    const adjNum = Number(adjValue) || 0;
    const adjReasonTrimmed = adjReason.trim();

    try {
      let orderId;

      if (isRealEdit) {
        // G28 — Real-Time Offline Order Editing. An unsynced order has no server row
        // to PATCH yet; rewrite the local receipt and the still-queued outbox payload
        // in place instead. If the order actually drained while this modal was open,
        // updateLocalOrder throws (its outbox record is gone) — fall back to the
        // ordinary online PATCH below rather than losing the edit.
        let wroteLocally = false;
        if (offlineUnsynced) {
          try {
            await updateLocalOrder({
              order: editOrder,
              items,
              notes,
              adjustment: { value: adjNum, reason: adjReasonTrimmed },
              personnel: personnelWithNames,
            });
            orderId = editOrder.receipt_number;
            wroteLocally = true;
          } catch {
            // Already drained — fall through to the online PATCH below.
          }
        }

        if (!wroteLocally) {
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
          const targetId = editOrder.id ?? editOrder.receipt_number;
          await api.patch(`/orders/${targetId}`, payload);
          orderId = targetId;

          const existingAdjNum    = Number(editOrder.adjustment) || 0;
          const existingAdjReason = editOrder.adjustment_reason || '';
          if (adjNum !== existingAdjNum || adjReasonTrimmed !== existingAdjReason) {
            await api.patch(`/orders/${orderId}/adjustment`, {
              adjustment: adjNum,
              adjustment_reason: adjReasonTrimmed,
            });
          }
        }
        addToast('Order updated.', 'success');
      } else {
        // G27 — single local-first save code path. No server round trip, online or
        // offline, every day: writes locally, issues the receipt number, queues the
        // outbox POST, and (below) navigates immediately — 0ms checkout.
        const saved = await saveOrderLocalFirst({
          customer: selectedCustomer ?? (customerId ? { id: customerId } : null),
          orderType,
          notes,
          adjustment: { value: adjNum, reason: adjReasonTrimmed },
          items,
          personnel: personnelWithNames,
        });
        orderId = saved.receipt_number;

        // The early draft this modal created on customer-pick (or the pre-existing
        // draft being resumed) is now superseded — best-effort cleanup only, never
        // queued (see cleanupOrphanedDraftDirect / discardDraftRef).
        if (draftPromiseRef.current) {
          draftPromiseRef.current.then((ref) => discardDraftRef(ref)).catch(() => {});
        } else if (draftIdRef.current) {
          discardDraftRef(draftIdRef.current);
        }

        addToast('Order created.', 'success');
      }

      // checkIsOnline() gate (captain 2026-08-31): customer_product_prices has no unique
      // constraint, so two offline tablets saving different prices for the same
      // customer/product would both land with no signal to either operator. The line-item
      // override this order actually charges is unaffected — only remembering it as the
      // customer's new standing price waits for a connection. Skips silently; no toast.
      //
      // A customer created moments ago in this same order (isLocalCustomer(customerId))
      // is not excluded: she deserves the prompt exactly as much as an existing customer
      // does, and persistPriceSave below queues her price behind a $ref on her own
      // outbox record rather than needing her real id already.
      if (dirtyItems.length && selectedCustomer && checkIsOnline()) {
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
  //
  // Routed through the outbox (matching handleCreateCustomer above) rather than a bare
  // api.post — this prompt fires from inside saveOrderLocalFirst's otherwise fully
  // offline-safe save flow, so a price agreed during an outage used to vanish silently
  // instead of queuing like the rest of the order. priceSavePrompt.customer may still be
  // local (isLocalCustomer) when she was quick-created earlier in this same order — her
  // real id doesn't exist yet, so the record's endpoint carries a `:customerId`
  // placeholder resolved from her own outbox record (see `endpointParams` on enqueue)
  // once her POST /customers drains, same pass or a later one.
  const persistPriceSave = async () => {
    setPriceSavePrompt((p) => ({ ...p, busy: true }));
    try {
      const profileKey = await api.getActiveProfile();
      const customer = priceSavePrompt.customer;
      const local = isLocalCustomer(customer.id);
      await Promise.all(priceSavePrompt.dirty.map((d) =>
        enqueue({
          entityType: 'customer_price',
          endpoint:   local ? '/customers/:customerId/prices' : `/customers/${customer.id}/prices`,
          endpointParams: local ? { customerId: ref(customer._outboxId, 'id') } : null,
          method:     'POST',
          payload: {
            product_id:        d.product_id,
            custom_unit_price: d.unit_price,
            order_type:        priceSavePrompt.orderType,
          },
          profileKey,
          dependsOn: local ? [customer._outboxId] : [],
        })
      ));
      addToast('Custom price saved.', 'success');
      drainOutbox().catch(() => {});
    } catch (err) {
      addToast(err.message || 'Failed to save custom price.', 'error');
    } finally {
      setPriceSavePrompt(null);
      onSaved(priceSavePrompt?.orderId);
    }
  };

  // ── Mis-tagged-customer nudge handlers ─────────────────────────────────────
  // Retagging is the whole action: pricing already follows the saved rows (ADR 0009), so this
  // only makes the label agree with them. Nothing about the order in progress changes.
  const applyCustomerTag = async (customerType) => {
    setTagPrompt((p) => ({ ...p, busy: true }));
    const { customer } = tagPrompt;
    try {
      const updated = await api.patch(`/customers/${customer.id}`, { customer_type: customerType });
      setCustomers((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      addToast(`${updated.name} tagged as ${customerTypeLabel(customerType)}.`, 'success');
      setTagPrompt(null);
    } catch (err) {
      addToast(err.message || 'Failed to update customer type.', 'error');
      setTagPrompt((p) => (p ? { ...p, busy: false } : null));
    }
  };

  // Discard draft completely (distinct from Reset).
  //
  // A locally parked draft is discarded on the device with no network at all, so
  // Discard works blind for the drafts an outage actually produces. A server-side
  // draft still needs the line — it is a synced row, and ADR 0015 §5 keeps deletes
  // online-only — so say that plainly instead of leaving a dead button.
  const handleDiscard = async () => {
    if (!draftId) { onClose(); return; }
    setSaving(true);
    try {
      if (draftLocalRef.current) {
        await discardLocalDraft(draftIdRef.current);
        cleanupOrphanedDraftDirect(draftIdRef.current);
      } else {
        await api.del(`/orders/${draftIdRef.current}`);
      }
      addToast('Draft discarded.', 'success');
      onSaved(); // no orderId -> returns to list
    } catch (err) {
      addToast(
        err?.status ? (err.message || 'Failed to discard draft.')
                    : 'Offline — this draft is on the server and needs a connection to discard.',
        'error'
      );
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
                <span>{isRealEdit ? `Edit Order ${orderRef(editOrder)}` : isDraftResume ? `Draft ${editOrder?._local ? editOrder.receipt_number : orderRef(editOrder)}` : 'New Order'}</span>
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
            <div className="relative grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem] lg:divide-x divide-slate-200 overflow-hidden">

              {/* ── LEFT COLUMN: Product Catalogue ──────────────────── */}
              {/* pb-24 (D3): keeps the last row of tiles clear of the collapsed bottom-sheet
                  bar below `lg`, where the sheet overlays this column. Untouched at `lg`+. */}
              <div className="flex flex-col min-h-0 h-full p-4 pb-24 sm:p-5 sm:pb-24 lg:pb-5 overflow-hidden bg-slate-50/40">
                {/* D3.1 — phone-width-only header for customer + order type, pinned above
                    the grid. Starts open; auto-collapses to a one-line summary once a
                    customer is picked; tap the summary to reopen and change it. Hidden at
                    `lg`+, where these fields live in their original spot below (D2). */}
                <div className="lg:hidden shrink-0 mb-3">
                  {customerHeaderOpen ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-3 shadow-sm">
                      <CustomerAndOrderTypeFields
                        activeCustomers={activeCustomers}
                        selectedCustomer={selectedCustomer}
                        onSelectCustomer={(c) => { setCustomerId(String(c.id)); setCustomerHeaderPinnedOpen(false); }}
                        onQueryChange={() => setCustomerId('')}
                        onCreateCustomer={handleCreateCustomer}
                        creatingCustomer={creatingCustomer}
                        customPrices={customPrices}
                        orderType={orderType}
                        setOrderType={setOrderType}
                        isEdit={isEdit}
                        customerError={errors.customer}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCustomerHeaderPinnedOpen(true)}
                      className="flex h-12 w-full items-center justify-between gap-2 rounded-xl
                                 border border-slate-200 bg-white px-3.5 text-sm font-semibold
                                 text-slate-900 shadow-sm focus-visible:outline-none
                                 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      <span className="truncate">
                        {selectedCustomer?.name} · {orderType === 'delivery' ? 'Delivery' : 'Pickup'}
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-slate-500">✎ Change</span>
                    </button>
                  )}
                </div>

                <div className="min-h-0 flex-1">
                  <POSProductGrid
                    products={activeProducts}
                    orderQty={orderQty}
                    onAdd={addProduct}
                    priceFor={priceFor}
                  />
                </div>
              </div>

              {/* ── RIGHT COLUMN: Order Panel ───────────────────────── */}
              {/* D3 — below `lg` this is a bottom sheet (absolute, collapsed to the summary
                  bar below unless sheetExpanded) laid over the product grid. At `lg`+ every
                  positioning class here is neutralized (lg:static etc.) and the column renders
                  exactly as it always has, side-by-side with the grid (D2). */}
              <div
                className={`absolute inset-x-0 bottom-0 z-10 flex flex-col overflow-hidden rounded-t-2xl
                            border-t border-slate-200 bg-white shadow-[0_-6px_24px_-6px_rgba(15,23,42,0.3)]
                            transition-[height] duration-300 ease-out
                            ${sheetExpanded ? 'h-[88%]' : 'h-16'}
                            lg:static lg:z-auto lg:h-full lg:min-h-0 lg:rounded-none lg:border-t-0
                            lg:shadow-none lg:transition-none`}
              >
                {/* Collapsed/expand handle — phone width only */}
                <button
                  type="button"
                  onClick={() => setSheetExpanded((v) => !v)}
                  aria-expanded={sheetExpanded}
                  aria-controls="order-cart-sheet-body"
                  className="lg:hidden flex w-full shrink-0 flex-col items-center justify-center gap-1
                             h-16 px-4 focus-visible:outline-none focus-visible:ring-2
                             focus-visible:ring-inset focus-visible:ring-blue-600"
                >
                  <span aria-hidden="true" className="h-1 w-10 rounded-full bg-slate-300" />
                  <span className="flex w-full items-center justify-between gap-2 text-sm">
                    <span className="font-bold text-slate-900 tabular-nums truncate">
                      {totalCases(items)} cs · {PHP(totals.total)}
                    </span>
                    <span className="flex items-center gap-1 font-semibold text-blue-700 shrink-0">
                      {sheetExpanded ? 'Hide cart' : 'View cart'}
                      <span aria-hidden="true">{sheetExpanded ? '▾' : '▴'}</span>
                    </span>
                  </span>
                </button>

                <div
                  id="order-cart-sheet-body"
                  className={`min-h-0 flex-1 flex-col overflow-hidden ${sheetExpanded ? 'flex' : 'hidden'} lg:flex`}
                >

                {/* Order Header: Customer & Order Type — hidden below `lg` (D3.1: these
                    fields live in the pinned header above the grid there instead). At
                    `lg`+ this renders exactly as it always has (D2). */}
                <div className="hidden lg:block p-4 border-b border-slate-200 shrink-0 space-y-3 bg-white">
                  <CustomerAndOrderTypeFields
                    activeCustomers={activeCustomers}
                    selectedCustomer={selectedCustomer}
                    onSelectCustomer={(c) => setCustomerId(String(c.id))}
                    onQueryChange={() => setCustomerId('')}
                    onCreateCustomer={handleCreateCustomer}
                    creatingCustomer={creatingCustomer}
                    customPrices={customPrices}
                    orderType={orderType}
                    setOrderType={setOrderType}
                    isEdit={isEdit}
                    customerError={errors.customer}
                  />
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

      {/* ── Regular customer holding saved prices — tag them? ──────────────── */}
      {tagPrompt && (
        <Modal
          title="Custom Prices Found"
          onClose={() => setTagPrompt(null)}
          cancelLabel="Skip"
          loading={tagPrompt.busy}
        >
          <p className="text-slate-700">
            <strong>{tagPrompt.customer.name}</strong> has custom prices — would you like to tag
            them as Markup, Discounted, or Wholesale?
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Their saved prices apply to this order either way. This only corrects the label.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2">
            {[
              { value: 'markup',     label: 'Markup',     desc: 'Agreed higher rates' },
              { value: 'discounted', label: 'Discounted', desc: 'Agreed lower rates' },
              { value: 'wholesaler', label: 'Wholesale',  desc: 'Bulk buyer' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={tagPrompt.busy}
                onClick={() => applyCustomerTag(opt.value)}
                className="flex min-h-[48px] items-center justify-between gap-3 rounded-lg border
                           border-slate-300 bg-white px-4 py-2.5 text-left transition-colors
                           hover:border-blue-500 hover:bg-blue-50/50 focus-visible:outline-none
                           focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
              >
                <span className="text-base font-semibold text-slate-800">{opt.label}</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold
                                  ${customerTypeBadge(opt.value)}`}>
                  {opt.desc}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}

    </>
  );
}
