import React, { useEffect, useState, useMemo, useRef } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import { customerMatches } from '../../utils/customerSearch';

const FIELD = `w-full h-12 rounded-lg border border-v2-border bg-v2-bg px-4 text-base text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const LABEL = 'block text-sm font-bold uppercase tracking-wide text-v2-muted mb-1';

// Customer Merge Modal (Housekeeping)
// Safely merges duplicate customer profiles into a single target customer:
// - All order history is transferred to the TO customer.
// - The FROM profile is permanently deleted.
// - TO customer retains all profile info and pricing matrix.
export default function CustomerMergeModal({ customer, orderCount = 0, onClose, onMerged }) {
  const { addToast } = useToast();

  const [customers, setCustomers]             = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [targetCustomer, setTargetCustomer]   = useState(null);
  const [query, setQuery]                     = useState('');
  const [open, setOpen]                       = useState(false);
  const [merging, setMerging]                 = useState(false);
  const blurTimer = useRef(null);

  // Load active customers excluding the current source customer
  useEffect(() => {
    let mounted = true;
    api.get('/customers')
      .then((data) => {
        if (!mounted) return;
        const available = data.filter((c) => c.is_active && String(c.id) !== String(customer?.id));
        setCustomers(available);
      })
      .catch(() => {
        addToast('Failed to load customers for merge.', 'error');
      })
      .finally(() => {
        if (mounted) setLoadingCustomers(false);
      });
    return () => { mounted = false; };
  }, [customer?.id, addToast]);

  const matches = useMemo(() => {
    return customers.filter((c) => customerMatches(c, query)).slice(0, 50);
  }, [customers, query]);

  const closeSoon = () => {
    blurTimer.current = setTimeout(() => setOpen(false), 150);
  };

  const cancelClose = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  const pickTarget = (cust) => {
    setTargetCustomer(cust);
    setQuery('');
    setOpen(false);
  };

  const handleConfirmMerge = async () => {
    if (!targetCustomer || merging) return;

    setMerging(true);
    try {
      const res = await api.post(`/customers/${customer.id}/merge`, {
        target_customer_id: targetCustomer.id,
      });

      const count = res.orders_transferred ?? orderCount ?? 0;
      addToast(
        `Merged ${customer.name} into ${targetCustomer.name} (${count} order${count !== 1 ? 's' : ''} transferred)`,
        'success'
      );
      onMerged?.(res);
    } catch (err) {
      addToast(err.message || 'Failed to merge customers.', 'error');
      setMerging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-customer-title"
      onClick={(e) => { if (e.target === e.currentTarget && !merging) onClose(); }}
    >
      <div className="my-8 flex w-full max-w-lg flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="text-xl">🔀</span>
            <h2 id="merge-customer-title" className="text-xl font-bold text-v2-text">
              Merge Customer
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={merging}
            aria-label="Close"
            className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text disabled:opacity-40
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 px-6 py-5">
          {/* Target Customer Picker */}
          <div>
            <label htmlFor="target-customer-search" className={LABEL}>
              Select Target Customer to Keep (TO) *
            </label>

            {loadingCustomers ? (
              <div className="flex h-12 items-center justify-center rounded-lg border border-v2-border bg-v2-bg">
                <Spinner size="sm" />
              </div>
            ) : targetCustomer ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-v2-text">{targetCustomer.name}</span>
                    <span className="font-mono text-xs text-v2-muted">#{targetCustomer.id}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      targetCustomer.customer_type === 'wholesaler'
                        ? 'border border-amber-500/30 bg-amber-500/20 text-amber-300'
                        : 'border border-v2-border bg-v2-raised text-v2-muted'
                    }`}>
                      {targetCustomer.customer_type === 'wholesaler' ? 'Wholesaler' : 'Regular'}
                    </span>
                  </div>
                  {targetCustomer.address && (
                    <p className="mt-0.5 truncate text-xs text-v2-muted">{targetCustomer.address}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setTargetCustomer(null)}
                  disabled={merging}
                  className="flex h-9 items-center rounded-lg bg-v2-raised px-3 text-xs font-bold text-v2-text hover:bg-v2-border
                             disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  id="target-customer-search"
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                  onFocus={() => { cancelClose(); setOpen(true); }}
                  onBlur={closeSoon}
                  placeholder="Search target customer by name or phone…"
                  className={FIELD}
                  role="combobox"
                  aria-expanded={open}
                  aria-autocomplete="list"
                  autoFocus
                />

                {open && (
                  <ul
                    role="listbox"
                    className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-v2-border
                               bg-v2-surface shadow-2xl"
                  >
                    {matches.length === 0 ? (
                      <li className="px-4 py-3 text-sm text-v2-muted">
                        {query ? 'No matching customers found.' : 'No other active customers.'}
                      </li>
                    ) : (
                      matches.map((c) => (
                        <li key={c.id} role="option" aria-selected={false}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pickTarget(c)}
                            className="flex min-h-[48px] w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm
                                       hover:bg-v2-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold text-v2-text">{c.name}</span>
                              <span className="ml-1.5 font-mono text-xs text-v2-muted">#{c.id}</span>
                              {c.address && (
                                <p className="truncate text-xs text-v2-muted">{c.address}</p>
                              )}
                            </div>
                            <span className="shrink-0 text-xs text-v2-muted">
                              {c.customer_type === 'wholesaler' ? 'Wholesaler' : 'Regular'}
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Merge Summary Card */}
          <div className="rounded-xl border border-v2-border bg-v2-bg p-4 space-y-3">
            <p className="text-xs font-bold uppercase tracking-widest text-v2-muted">Merge Summary</p>

            {/* FROM */}
            <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide text-red-400">
                  Duplicate to remove (FROM)
                </span>
                <span className="font-mono text-xs text-red-300">#{customer?.id}</span>
              </div>
              <p className="mt-1 font-bold text-v2-text text-base">{customer?.name}</p>
              <p className="mt-0.5 text-xs text-red-300">
                {orderCount} {orderCount === 1 ? 'order' : 'orders'} will be transferred
              </p>
            </div>

            {/* Transition Indicator */}
            <div className="flex justify-center text-v2-muted font-bold text-lg">
              ↓
            </div>

            {/* TO */}
            <div className={`rounded-lg border p-3 ${
              targetCustomer
                ? 'border-emerald-500/30 bg-emerald-950/20'
                : 'border-dashed border-v2-border bg-v2-surface'
            }`}>
              <div className="flex items-center justify-between">
                <span className={`text-xs font-bold uppercase tracking-wide ${
                  targetCustomer ? 'text-emerald-400' : 'text-v2-muted'
                }`}>
                  Target customer to keep (TO)
                </span>
                {targetCustomer && (
                  <span className="font-mono text-xs text-emerald-300">#{targetCustomer.id}</span>
                )}
              </div>
              {targetCustomer ? (
                <>
                  <p className="mt-1 font-bold text-v2-text text-base">{targetCustomer.name}</p>
                  <p className="mt-0.5 text-xs text-emerald-300">
                    Retains profile details, pricing matrix, and receives all transferred orders
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm italic text-v2-muted">Select a target customer above…</p>
              )}
            </div>
          </div>

          {/* Warning Banner */}
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 p-4">
            <p className="text-sm font-semibold text-amber-200">
              ⚠️ Warning: This action permanently removes the duplicate profile and moves all order history to{' '}
              <span className="font-bold text-amber-100">{targetCustomer?.name ?? 'the target customer'}</span>.
              It cannot be undone.
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-v2-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={merging}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                       font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmMerge}
            disabled={!targetCustomer || merging}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-amber-600 px-5 text-base
                       font-bold text-white hover:bg-amber-500 disabled:opacity-40
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            {merging ? 'Merging…' : 'Confirm & Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
