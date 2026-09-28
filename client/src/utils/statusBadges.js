// One status and stock vocabulary for every screen (docs/design/design-standard.md,
// Q5). Each entry is a colour AND a word — a badge is never colour alone — and each
// colour means one thing wherever it appears. Before this file the Dashboard carried
// its own map with Pending and In Transit swapped and "Completed"/"Done" for what
// every other screen calls "Delivered"/"Closed" (UI audit F3).

const TONES = {
  violet: 'bg-violet-100 text-violet-800 border-violet-300',
  blue:   'bg-blue-100 text-blue-800 border-blue-300',
  amber:  'bg-amber-100 text-amber-900 border-amber-300',
  green:  'bg-green-100 text-green-800 border-green-300',
  slate:  'bg-slate-100 text-slate-700 border-slate-300',
  red:    'bg-red-100 text-red-800 border-red-300',
};

export const ORDER_STATUS = {
  draft:      { label: 'Draft',      tone: 'violet' },
  pending:    { label: 'Pending',    tone: 'blue' },
  in_transit: { label: 'In Transit', tone: 'amber' },
  completed:  { label: 'Delivered',  tone: 'green' },
  done:       { label: 'Closed',     tone: 'slate' },
  cancelled:  { label: 'Cancelled',  tone: 'red' },
};

// Tickets share the order words where they mean the same thing: an open ticket is
// Pending in the same blue an open order is.
export const TICKET_STATUS = {
  pending:  { label: 'Pending',  tone: 'blue' },
  resolved: { label: 'Resolved', tone: 'green' },
};

export const STOCK_STATE = {
  out:      { label: 'Out of stock', tone: 'red' },
  low:      { label: 'Low stock',    tone: 'amber' },
  inactive: { label: 'Inactive',     tone: 'slate' },
};

// Everything else a card can carry. Amber is "needs attention"; slate is neutral fact.
export const TAG = {
  pickup:     { label: 'Pickup',              tone: 'blue' },
  delivery:   { label: 'Delivery',            tone: 'slate' },
  printed:    { label: 'Printed',             tone: 'slate' },
  notPrinted: { label: 'Not printed',         tone: 'amber' },
  unsynced:   { label: 'Waiting to sync',     tone: 'amber' },
  duplicate:  { label: 'Possible duplicate',  tone: 'amber' },
  inactive:   { label: 'Inactive',            tone: 'slate' },
  active:     { label: 'Active',              tone: 'green' },
};

// The stock level the whole app calls "low" — also the Dashboard's Low Stock list.
export const LOW_STOCK_THRESHOLD = 10;

export function toneClass(tone) {
  return TONES[tone] ?? TONES.slate;
}

function entry(map, key) {
  const e = map[key];
  return e
    ? { label: e.label, className: toneClass(e.tone) }
    : { label: key == null ? '' : String(key), className: TONES.slate };
}

export const orderStatusBadge  = (status) => entry(ORDER_STATUS, status);
export const ticketStatusBadge = (status) => entry(TICKET_STATUS, status);
export const tagBadge          = (kind) => entry(TAG, kind);
export const orderStatusLabel  = (status) => ORDER_STATUS[status]?.label ?? status;

// 'out' | 'low' | null — null is ordinary stock and gets no badge.
export function stockState(stock) {
  const n = Number(stock);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 'out';
  if (n <= LOW_STOCK_THRESHOLD) return 'low';
  return null;
}

export function stockBadge(stock) {
  const s = stockState(stock);
  return s ? entry(STOCK_STATE, s) : null;
}
