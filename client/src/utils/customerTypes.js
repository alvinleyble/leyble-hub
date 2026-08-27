// ADR 0009 — `customer_type` is a purely descriptive tag.
//
// It used to do two jobs at once: label who a customer is, AND decide whether that
// customer's saved prices were read at order time. The read side was spelled as a
// literal type list repeated across seven screens
// (`['wholesaler','discounted','markup','unassigned'].includes(...)`), so any screen
// that missed one string silently billed the customer at base price.
//
// Pricing is now derived from the data instead: a customer is on custom pricing when
// `customer_product_prices` returns rows for the current order type — see
// `hasCustomPricing()` below, which is the only test any screen should make. The type
// is a label and nothing else.
//
// `unassigned` was collapsed into `regular` (migration 034): it never meant anything a
// reader could act on, and it only existed because saving a price used to force a type
// change. `normalizeCustomerType()` keeps any row or cached payload that predates that
// migration reading as `Regular`.

export const CUSTOMER_TYPES = ['regular', 'wholesaler', 'discounted', 'markup'];

// Descriptive labels — no "with/without custom prices" suffixes; the type says nothing
// about pricing any more.
export const CUSTOMER_TYPE_OPTIONS = [
  { value: 'regular',    label: 'Regular',    desc: 'Standard account' },
  { value: 'wholesaler', label: 'Wholesaler', desc: 'Bulk buyer' },
  { value: 'discounted', label: 'Discounted', desc: 'Agreed lower rates' },
  { value: 'markup',     label: 'Markup',     desc: 'Agreed higher rates' },
];

// Legacy `unassigned` rows read as `regular`; anything unrecognised does too.
export function normalizeCustomerType(type) {
  return CUSTOMER_TYPES.includes(type) ? type : 'regular';
}

export function customerTypeLabel(type) {
  const t = normalizeCustomerType(type);
  return CUSTOMER_TYPE_OPTIONS.find((o) => o.value === t).label;
}

// The V1 (light) badge palette, keyed by normalized type.
const LIGHT_BADGE = {
  regular:    'bg-slate-100 text-slate-600 border-slate-200',
  wholesaler: 'bg-amber-100 text-amber-800 border-amber-300',
  discounted: 'bg-blue-100 text-blue-800 border-blue-300',
  markup:     'bg-purple-100 text-purple-800 border-purple-300',
};

// The V2 (dark) badge palette, keyed by normalized type.
const DARK_BADGE = {
  regular:    'border border-v2-border bg-v2-raised text-v2-muted',
  wholesaler: 'border border-amber-500/30 bg-amber-500/20 text-amber-300',
  discounted: 'border border-blue-500/30 bg-blue-500/20 text-blue-300',
  markup:     'border border-purple-500/30 bg-purple-500/20 text-purple-300',
};

export function customerTypeBadge(type, theme = 'light') {
  const palette = theme === 'dark' ? DARK_BADGE : LIGHT_BADGE;
  return palette[normalizeCustomerType(type)];
}

// The ADR 0009 read rule, in one place: custom pricing applies when saved prices exist
// for this customer on this order type — never because of what the customer is tagged.
// `prices` is whatever `GET /customers/:id/prices?order_type=…` returned: an array, or
// the `{ [product_id]: row }` map the order screens keep it in.
export function hasCustomPricing(prices) {
  if (!prices) return false;
  return Array.isArray(prices) ? prices.length > 0 : Object.keys(prices).length > 0;
}
