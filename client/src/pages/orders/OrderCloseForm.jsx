import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Stepper from '../../components/ui/Stepper';
import { handleStaleOrderWrite } from './orderConcurrency.js';
import { formatPeso } from '../../utils/money';
import { bottleCredit, bottlesReturned } from './bottleReturns.js';

// Money on screen: the shared formatter (design standard Q15) — "−₱96.00", not "₱-96.00".
const PHP = formatPeso;

// Mirrors the order_items.line_total GENERATED column (migration 051) exactly:
// quantity * unit_price - bottles_returned * unit_deposit_fee. The listed price already
// includes every bottle's deposit, so returned bottles are a credit and nothing is ever
// added on top (bottleReturns.js). Only requires_bottle_return items get a live input
// below; the rest keep the bottles_returned they were saved with (normally 0).
export function breakdownForItem(item, returnCounts) {
  const qty = Number(item.quantity) || 0;
  const basePrice    = qty * (Number(item.unit_price) || 0);
  const totalBottles = qty * (Number(item.units_per_case) || 1);
  const returned     = bottlesReturned(item, returnCounts);
  const credit       = bottleCredit(item, returnCounts);

  return {
    hasDeposit: Number(item.unit_deposit_fee) > 0,
    basePrice, totalBottles, returned, credit, lineTotal: basePrice - credit,
  };
}

// Renders only when the order has returnable-bottle items — caller is responsible for that check.
// `returnCounts`/`onChangeReturnCounts` are lifted to the caller so the order summary above
// this form can show the same live deposit breakdown as the user types.
export default function OrderCloseForm({
  order, returnCounts, onChangeReturnCounts, onClosed, onBeforeClose, onStale, hideCloseButton,
}) {
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
      const updated = await api.post(`/orders/${order.id}/close`, { items, revision: order.revision });
      addToast('Order closed.', 'success');
      onClosed(updated);
    } catch (err) {
      const stale = await handleStaleOrderWrite(err, { addToast, onCurrent: onStale });
      if (!stale) addToast(err.message || 'Failed to close order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
      <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">Bottle Returns</p>
      <p className="text-sm text-slate-500 mb-4">
        Enter how many empty bottles were returned for each product. Enter 0 if none.
      </p>

      <div className="space-y-5">
        {bottleItems.map((item) => {
          const b = breakdownForItem(item, returnCounts);
          return (
            <div key={item.id}>
              <p className="text-sm font-semibold text-slate-800">{item.sku || item.product_name}</p>
              <p className="text-sm text-slate-500 mb-2">
                {b.totalBottles} total bottles ({item.quantity} cases × {item.units_per_case || 1})
              </p>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Bottles returned
              </label>
              <Stepper
                value={returnCounts[item.id] ?? ''}
                onChange={(v) => onChangeReturnCounts({ ...returnCounts, [item.id]: v })}
                step={1}
                min={0}
                label={`Bottles returned for ${item.sku || item.product_name}`}
              />
              {returnCounts[item.id] !== '' && b.credit > 0 && (
                <p className="text-sm mt-1 tabular-nums text-green-700">
                  Bottles returned {b.returned} × {PHP(item.unit_deposit_fee)} = {PHP(-b.credit)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!hideCloseButton && (
        <div className="mt-5 pt-4 border-t border-slate-400 flex justify-end">
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
