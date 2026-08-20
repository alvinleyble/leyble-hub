import React from 'react';
import CaseStepper from './CaseStepper';
import POSCustomerSearch from './POSCustomerSearch';
import { lineTotal, orderTotals, totalCases } from './posMath';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD = `h-12 w-full rounded-lg border border-v2-border bg-v2-bg px-3 text-lg text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const BIG_BTN = `flex min-h-[64px] w-full items-center justify-center gap-2 rounded-xl px-4 text-xl font-black
                 uppercase tracking-wide transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                 disabled:cursor-not-allowed disabled:opacity-50`;

const SMALL_BTN = `flex min-h-tablet items-center justify-center gap-2 rounded-xl px-4 text-base font-bold
                   transition-colors duration-100
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                   disabled:cursor-not-allowed disabled:opacity-50`;

// One order line: stepper, in-line price-per-case edit and a goods-only line total.
// Nothing deposit-derived is shown here — see posMath.js.
function OrderLine({ item, amber, locked, onStep, onPrice, onRemove }) {
  return (
    <li className={`rounded-xl border p-3 ${amber ? 'border-amber-500/40 bg-amber-950/20' : 'border-v2-border bg-v2-surface'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-bold tracking-wide text-v2-muted">{item.sku || '—'}</p>
          <p className="truncate text-base font-semibold text-v2-text">{item.product_name}</p>
        </div>
        <button
          type="button"
          onClick={() => onRemove(item._key)}
          disabled={locked}
          aria-label={`Remove ${item.product_name} from the order`}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-xl text-v2-muted
                     hover:bg-v2-raised hover:text-v2-text focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-v2-accent disabled:opacity-40"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-v2-muted">Cases</p>
          {locked ? (
            <p className="text-xl font-bold text-v2-text">{item.quantity} cs</p>
          ) : (
            <CaseStepper
              quantity={item.quantity}
              label={item.product_name}
              amber={amber}
              onStep={(delta) => onStep(item._key, delta)}
            />
          )}
        </div>

        <div className="w-32">
          <label
            htmlFor={`price-${item._key}`}
            className="mb-1 block text-xs font-bold uppercase tracking-wide text-v2-muted"
          >
            Price /cs
          </label>
          <input
            id={`price-${item._key}`}
            type="text"
            inputMode="decimal"
            value={item.unit_price}
            disabled={locked}
            onChange={(e) => onPrice(item._key, e.target.value)}
            className={`${FIELD} text-right tabular-nums disabled:opacity-60`}
          />
        </div>

        <div className="text-right">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-v2-muted">Line total</p>
          <p className="text-xl font-black tabular-nums text-v2-text">{PHP(lineTotal(item))}</p>
        </div>
      </div>

    </li>
  );
}

// The sticky POS order panel: customer, order type, lines, discount, goods-only
// totals and the 2-stage Save → Print buffer.
export default function POSOrderPanel({
  mode,                  // 'build' | 'saved' | 'edit'
  customers,
  selectedCustomer,
  onSelectCustomer,
  onClearCustomer,
  orderType,
  onOrderType,
  items,
  onStep,
  onPrice,
  onRemove,
  notes,
  onNotes,
  adjustment,            // { value, reason }
  onAdjustment,
  errors,
  draftStatus,
  savedOrder,
  editOrderId,
  saving,
  printing,
  onSave,
  onUpdate,
  onPrint,
  onReview,
  onEditSaved,
  onNewOrder,
  onClearOrder,
  onCancelOrder,
  onExitEdit,
}) {
  const amber  = mode === 'edit';
  const locked = mode === 'saved';
  const totals = orderTotals(items, Number(adjustment.value) || 0);
  const printed = Boolean(savedOrder?.pending_receipt_printed_at);

  return (
    <aside
      aria-label="Current order"
      className={`flex h-full min-h-0 w-full flex-col rounded-2xl border-2 ${
        amber ? 'border-amber-400 bg-amber-950/10' : 'border-v2-border bg-v2-surface'
      }`}
    >
      {/* Customer + order type */}
      <div className={`shrink-0 space-y-3 border-b p-3 ${amber ? 'border-amber-500/40' : 'border-v2-border'}`}>
        <POSCustomerSearch
          customers={customers}
          selected={selectedCustomer}
          onSelect={onSelectCustomer}
          onClear={onClearCustomer}
          disabled={mode !== 'build'}
        />
        {errors.customer && (
          <p role="alert" className="text-base font-semibold text-red-300">⚠ {errors.customer}</p>
        )}

        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-v2-muted">Order type</p>
          {mode === 'build' ? (
            <div className="mt-1 flex gap-2" role="group" aria-label="Order type">
              {[['delivery', '🚚 Delivery'], ['pickup', '🏪 Pickup']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onOrderType(value)}
                  aria-pressed={orderType === value}
                  className={`flex min-h-tablet flex-1 items-center justify-center rounded-xl border text-base font-bold
                              transition-colors duration-100 focus-visible:outline-none
                              focus-visible:ring-2 focus-visible:ring-v2-accent
                              ${orderType === value
                                ? 'border-v2-accent bg-v2-pill-active text-v2-pill-text shadow-sm'
                                : 'border-v2-border bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-lg font-bold text-v2-text">
              {orderType === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
            </p>
          )}
        </div>
      </div>

      {/* Lines */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <p className="py-10 text-center text-lg text-v2-muted">
            Tap a product to start the order.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <OrderLine
                key={item._key}
                item={item}
                amber={amber}
                locked={locked}
                onStep={onStep}
                onPrice={onPrice}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
        {errors.items && (
          <p role="alert" className="mt-2 text-base font-semibold text-red-300">⚠ {errors.items}</p>
        )}

        {/* Discount / suki adjustment */}
        <div className="mt-4 space-y-2">
          <div>
            <label htmlFor="pos-adjustment" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
              Adjustment
            </label>
            <input
              id="pos-adjustment"
              type="text"
              inputMode="decimal"
              value={adjustment.value}
              disabled={locked}
              placeholder="0.00  (minus to discount)"
              onChange={(e) => onAdjustment({ ...adjustment, value: e.target.value })}
              className={`${FIELD} mt-1 tabular-nums disabled:opacity-60`}
            />
          </div>
          {Number(adjustment.value) !== 0 && (
            <div>
              <label htmlFor="pos-adjustment-reason" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
                Reason (required)
              </label>
              <input
                id="pos-adjustment-reason"
                type="text"
                value={adjustment.reason}
                disabled={locked}
                placeholder="Suki discount"
                onChange={(e) => onAdjustment({ ...adjustment, reason: e.target.value })}
                className={`${FIELD} mt-1 disabled:opacity-60`}
              />
            </div>
          )}
          {errors.adjustment && (
            <p role="alert" className="text-base font-semibold text-red-300">⚠ {errors.adjustment}</p>
          )}

          <div>
            <label htmlFor="pos-notes" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
              Notes
            </label>
            <input
              id="pos-notes"
              type="text"
              value={notes}
              disabled={locked}
              placeholder="Optional"
              onChange={(e) => onNotes(e.target.value)}
              className={`${FIELD} mt-1 disabled:opacity-60`}
            />
          </div>
        </div>
      </div>

      {/* Totals + actions */}
      <div className={`shrink-0 space-y-3 border-t p-3 ${amber ? 'border-amber-500/40' : 'border-v2-border'}`}>
        <dl className="space-y-1 text-base">
          <div className="flex justify-between">
            <dt className="text-v2-muted">Items ({totalCases(items)} cs)</dt>
            <dd className="tabular-nums text-v2-text">{PHP(totals.goods)}</dd>
          </div>
          {totals.adjustment !== 0 && (
            <div className="flex justify-between">
              <dt className="truncate text-v2-muted">
                Adjustment{adjustment.reason ? ` (${adjustment.reason})` : ''}
              </dt>
              <dd className="tabular-nums text-v2-text">
                {totals.adjustment > 0 ? '+' : ''}{PHP(totals.adjustment)}
              </dd>
            </div>
          )}
          <div className="flex items-baseline justify-between pt-1">
            <dt className="text-lg font-black uppercase tracking-wide text-v2-text">Total due</dt>
            <dd className="text-3xl font-black tabular-nums text-v2-text">{PHP(totals.total)}</dd>
          </div>
        </dl>

        {mode === 'build' && (
          <>
            <div className="flex items-stretch gap-2">
              <span
                aria-live="polite"
                className="flex min-h-[64px] w-24 shrink-0 flex-col items-center justify-center rounded-xl
                           bg-v2-raised px-2 text-center text-xs font-bold leading-tight text-v2-muted"
              >
                <span className="text-base">📝</span>
                {draftStatus === 'saving' ? 'Saving…' : draftStatus === 'saved' ? 'Draft saved' : 'Draft'}
              </span>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className={`${BIG_BTN} bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm`}
              >
                {saving ? 'Saving…' : '💾 Save Order'}
              </button>
            </div>
            <button
              type="button"
              onClick={onClearOrder}
              disabled={saving || (items.length === 0 && !selectedCustomer)}
              className={`${SMALL_BTN} w-full bg-v2-raised text-v2-text hover:bg-v2-border`}
            >
              🗑 Clear order
            </button>
          </>
        )}

        {mode === 'saved' && savedOrder && (
          <>
            <p
              className={`rounded-xl px-3 py-2 text-base font-bold ${
                printed
                  ? 'bg-emerald-500/15 text-emerald-200'
                  : 'bg-amber-500/15 text-amber-200'
              }`}
              aria-live="polite"
            >
              ✅ Order #{savedOrder.id} created — {printed ? '🖨️ receipt printed' : '⚠️ NOT PRINTED yet'}
            </p>
            <button
              type="button"
              onClick={onPrint}
              disabled={printing}
              className={`${BIG_BTN} bg-v2-accent-strong text-white hover:bg-v2-accent shadow-sm`}
            >
              {printing ? 'Printing…' : '🖨️ Print Receipt (2 copies)'}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onReview}
                className={`${SMALL_BTN} flex-1 bg-v2-raised text-v2-text hover:bg-v2-border`}
              >
                📝 Review Order
              </button>
              <button
                type="button"
                onClick={onEditSaved}
                className={`${SMALL_BTN} flex-1 bg-amber-500 text-amber-950 hover:bg-amber-400`}
              >
                ✏️ Edit Order
              </button>
            </div>
            <button
              type="button"
              onClick={onNewOrder}
              className={`${SMALL_BTN} w-full bg-v2-raised text-v2-text hover:bg-v2-border`}
            >
              ＋ New order
            </button>
          </>
        )}

        {mode === 'edit' && (
          <>
            <button
              type="button"
              onClick={onUpdate}
              disabled={saving}
              className={`${BIG_BTN} bg-amber-500 text-amber-950 hover:bg-amber-400`}
            >
              {saving ? 'Saving…' : `💾 Update Order (#${editOrderId})`}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancelOrder}
                disabled={saving}
                className={`${SMALL_BTN} flex-1 bg-red-700 text-white hover:bg-red-600`}
              >
                🚫 Cancel Order
              </button>
              <button
                type="button"
                onClick={onExitEdit}
                disabled={saving}
                className={`${SMALL_BTN} flex-1 bg-v2-raised text-v2-text hover:bg-v2-border`}
              >
                ✕ Exit Edit Mode
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
