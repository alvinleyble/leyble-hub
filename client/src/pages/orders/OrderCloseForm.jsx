import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Mirrors the order_items.line_total GENERATED column (migration 023) exactly:
// quantity * unit_price + (quantity * units_per_case - bottles_returned) * unit_deposit_fee
// Note the DB formula charges the deposit whenever unit_deposit_fee > 0 — it does NOT
// check requires_bottle_return. That flag only controls whether the close form below
// shows an input for this item (see `bottleItems`); items without one keep whatever
// bottles_returned they were saved with (normally 0) and still carry their deposit in
// full. Gating depositOwed on requires_bottle_return here would under-report lineTotal
// for such items and make the subtotals disagree with the order's real total.
export function breakdownForItem(item, returnCounts) {
  const qty   = Number(item.quantity) || 0;
  const price = Number(item.unit_price) || 0;
  const dep   = Number(item.unit_deposit_fee) || 0;
  const upc   = Number(item.units_per_case) || 1;
  const hasDeposit = dep > 0;
  // Only requires_bottle_return items get a live input below — that's the one case
  // where an in-progress (possibly empty-string) returnCounts entry should win over
  // the saved bottles_returned.
  const tracked = hasDeposit && item.requires_bottle_return;

  const basePrice    = qty * price;
  const totalBottles = qty * upc;
  const entry = returnCounts[item.id];
  const rawReturned = tracked && entry !== undefined && entry !== ''
    ? Number(entry) || 0
    : Number(item.bottles_returned) || 0;
  const returned    = Math.max(rawReturned, 0);
  const unreturned  = totalBottles - returned;
  const depositOwed = hasDeposit ? unreturned * dep : 0;

  return { hasDeposit, basePrice, totalBottles, returned, unreturned, depositOwed, lineTotal: basePrice + depositOwed };
}

// Renders only when the order has returnable-bottle items — caller is responsible for that check.
// `returnCounts`/`onChangeReturnCounts` are lifted to the caller so the order summary above
// this form can show the same live deposit breakdown as the user types.
export default function OrderCloseForm({ order, returnCounts, onChangeReturnCounts, onClosed, onBeforeClose, hideCloseButton }) {
  const { addToast } = useToast();
  const bottleItems = order.items.filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0);

  const [closing, setClosing] = useState(false);

  const handleClose = async () => {
    setClosing(true);
    try {
      if (onBeforeClose) await onBeforeClose();
      const items = Object.entries(returnCounts).map(([itemId, returned]) => ({
        id: Number(itemId),
        bottles_returned: Number(returned) || 0,
      }));
      const updated = await api.post(`/orders/${order.id}/close`, { items });
      addToast('Order closed.', 'success');
      onClosed(updated);
    } catch (err) {
      addToast(err.message || 'Failed to close order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Bottle Returns</p>
      <p className="text-sm text-slate-500 mb-4">
        Enter how many empty bottles were returned for each product. Enter 0 if none.
      </p>

      <div className="space-y-5">
        {bottleItems.map((item) => {
          const b = breakdownForItem(item, returnCounts);
          return (
            <div key={item.id}>
              <p className="text-sm font-semibold text-slate-800">{item.sku || item.product_name}</p>
              <p className="text-xs text-slate-500 mb-2">
                {b.totalBottles} total bottles ({item.quantity} cases × {item.units_per_case || 1})
              </p>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Bottles returned
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={returnCounts[item.id] ?? ''}
                onChange={(e) =>
                  onChangeReturnCounts({ ...returnCounts, [item.id]: e.target.value })
                }
                className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base
                           focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder="0"
              />
              {returnCounts[item.id] !== '' && (
                <p className={`text-xs mt-1 tabular-nums ${b.depositOwed < 0 ? 'text-green-700' : 'text-slate-500'}`}>
                  {b.depositOwed < 0
                    ? `Credit: ${Math.abs(b.unreturned)} btls × ${PHP(Number(item.unit_deposit_fee))} = −${PHP(Math.abs(b.depositOwed))}`
                    : `Net deposit: ${b.unreturned} btls × ${PHP(Number(item.unit_deposit_fee))} = ${PHP(b.depositOwed)}`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!hideCloseButton && (
        <div className="mt-5 pt-4 border-t border-slate-200 flex justify-end">
          <Button
            onClick={handleClose}
            loading={closing}
            disabled={Object.values(returnCounts).some((v) => v === '')}
          >
            Close Order
          </Button>
        </div>
      )}
    </div>
  );
}
