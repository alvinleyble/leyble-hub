import React from 'react';
import { orderRef } from '../../utils/orderRef';

// Amber Edit Mode banner (proposal §2.5). Editing an existing order repaints the POS
// screen amber so it is never mistaken for a fresh order — the badge animates, and
// the reason the customer / order type are locked is stated right here in words.
export default function AmberEditHeader({ order }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-400 bg-amber-500/15 px-4 py-2">
      <span className="flex min-h-touch animate-pulse items-center rounded-lg bg-amber-400 px-3 text-base font-black
                       uppercase tracking-wide text-amber-950">
        ✏️ Edit Mode
      </span>
      <span className="text-lg font-bold text-amber-200">
        Editing Order {orderRef(order)}
      </span>
      <span className="text-base text-amber-100/80">
        Items, prices, discount and notes only — the customer and order type are locked.
        Wrong customer? Cancel this order and build a new one.
      </span>
    </div>
  );
}
