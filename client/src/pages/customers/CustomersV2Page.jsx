import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import CustomerCreateModal from '../../components/customers/CustomerCreateModal';
import CustomerDetailDrawer from '../../components/customers/CustomerDetailDrawer';
import CustomerMergeModal from '../../components/customers/CustomerMergeModal';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintList } from '../shared/usePrintList';
import { customerListHtml } from '../shared/listPrintTemplate';
import { customerListEscPos } from '../shared/listEscPos';
import { customerMatches } from '../../utils/customerSearch';
import { V25_OFFLINE_CORE } from '../../config/features';
import { findDuplicateCustomerGroups, getDuplicateCustomerIds, getDuplicateCandidatesFor } from '../../utils/duplicateCustomers';
import { customerTypeBadge, customerTypeLabel, normalizeCustomerType } from '../../utils/customerTypes';

const TOP_BTN = `flex h-12 items-center gap-1.5 rounded-xl bg-v2-raised px-4 text-base font-bold text-v2-text
                 hover:bg-v2-border transition-colors duration-100 disabled:opacity-40
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

// V2 Tablet Customers Directory & Suki Pricing Screen (proposal §3, Slice 3).
// Fast tablet-optimized directory with quick search, filter pills, dark slate tokens,
// and slide-over profile drawer with custom pricing matrix.
export default function CustomersV2Page() {
  const { addToast } = useToast();

  const [customers, setCustomers]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [typeFilter, setTypeFilter]     = useState('all'); // 'all' or any CUSTOMER_TYPES value
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);
  const [mergeCandidate, setMergeCandidate] = useState(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (showInactive) params.set('include_inactive', 'true');

    api.get(`/customers?${params}`)
      .then(setCustomers)
      .catch(() => addToast('Failed to load customers.', 'error'))
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [showInactive, addToast]);

  useEffect(() => { load(); }, [load]);

  const duplicateGroups = useMemo(() => {
    return V25_OFFLINE_CORE ? findDuplicateCustomerGroups(customers) : {};
  }, [customers]);

  const duplicateIds = useMemo(() => {
    return V25_OFFLINE_CORE ? getDuplicateCustomerIds(customers) : new Set();
  }, [customers]);

  const handleOpenDuplicateMerge = (e, customer) => {
    e.stopPropagation();
    const candidates = getDuplicateCandidatesFor(customer, customers);
    setMergeCandidate({
      from: customer,
      to: candidates[0] || null,
    });
  };

  const {
    printList, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePicker,
  } = usePrintList();

  const handlePrintList = () => printList(customerListHtml(customers), customerListEscPos(customers));

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      const matchSearch = customerMatches(c, search) || (c.phone && c.phone.toLowerCase().includes(search.toLowerCase()));
      const matchType = typeFilter === 'all' || normalizeCustomerType(c.customer_type) === typeFilter;
      return matchSearch && matchType;
    });
  }, [customers, search, typeFilter]);

  const pill = (active, label) =>
    `flex min-h-tablet items-center rounded-xl px-4 text-base font-semibold transition-colors duration-100
     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
     ${active
       ? 'bg-v2-pill-active text-v2-pill-text border border-v2-pill-border shadow-sm'
       : 'bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'
     }`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-2">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-v2-text">Customers</h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handlePrintList}
            disabled={printing || customers.length === 0}
            className={TOP_BTN}
          >
            🖶 {printing ? 'Printing…' : 'Print List'}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-12 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-base font-bold
                       text-white hover:bg-emerald-500 shadow-sm focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-v2-accent"
          >
            + Add Customer
          </button>
        </div>
      </div>

      {/* ── Search & Filters ─────────────────────────────────────── */}
      <div className="shrink-0 space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search by name, phone, or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search customers"
            className="h-12 flex-1 rounded-xl border border-v2-border bg-v2-bg px-4 text-base text-v2-text
                       placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          />
          <label className="flex min-h-tablet cursor-pointer select-none items-center gap-3 rounded-xl border
                            border-v2-border bg-v2-bg px-4">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-6 w-6 accent-v2-accent-strong"
            />
            <span className="whitespace-nowrap text-base font-medium text-v2-text">Show inactive</span>
          </label>
        </div>

        {!loading && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Customer type filters">
            <button
              type="button"
              onClick={() => setTypeFilter('all')}
              aria-pressed={typeFilter === 'all'}
              className={pill(typeFilter === 'all')}
            >
              All ({customers.length})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('wholesaler')}
              aria-pressed={typeFilter === 'wholesaler'}
              className={pill(typeFilter === 'wholesaler')}
            >
              Wholesaler ({customers.filter((c) => c.customer_type === 'wholesaler').length})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('discounted')}
              aria-pressed={typeFilter === 'discounted'}
              className={pill(typeFilter === 'discounted')}
            >
              Discounted ({customers.filter((c) => c.customer_type === 'discounted').length})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('markup')}
              aria-pressed={typeFilter === 'markup'}
              className={pill(typeFilter === 'markup')}
            >
              Markup ({customers.filter((c) => c.customer_type === 'markup').length})
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('regular')}
              aria-pressed={typeFilter === 'regular'}
              className={pill(typeFilter === 'regular')}
            >
              Regular ({customers.filter((c) => normalizeCustomerType(c.customer_type) === 'regular').length})
            </button>
          </div>
        )}
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-v2-border bg-v2-surface">
        {loading ? (
          <div className="flex h-64 items-center justify-center"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <p className="py-20 text-center text-lg text-v2-muted">
            {search ? 'No customers match your search.' : 'No customers found. Add one to get started.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="sticky top-0 z-10 bg-v2-bg">
                <tr className="border-b border-v2-border text-xs uppercase tracking-wider text-v2-muted">
                  <th className="px-5 py-3 text-left font-semibold">Customer</th>
                  <th className="hidden px-5 py-3 text-left font-semibold sm:table-cell">Type</th>
                  <th className="hidden px-5 py-3 text-left font-semibold md:table-cell">Phone</th>
                  <th className="hidden px-5 py-3 text-left font-semibold lg:table-cell">Address</th>
                  <th className="px-5 py-3 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className="cursor-pointer border-t border-v2-border transition-colors hover:bg-v2-raised"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`font-semibold text-lg ${c.is_active ? 'text-v2-text' : 'text-v2-muted line-through'}`}>
                          {c.name}
                        </p>
                        {V25_OFFLINE_CORE && duplicateIds.has(c.id) && (
                          <button
                            type="button"
                            onClick={(e) => handleOpenDuplicateMerge(e, c)}
                            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-300 hover:bg-amber-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                            title="Possible duplicate customer — click to review and merge"
                          >
                            ⚠️ possible duplicate
                          </button>
                        )}
                      </div>
                      {c.notes && (
                        <p className="mt-0.5 max-w-sm truncate text-xs italic text-v2-muted">{c.notes}</p>
                      )}
                    </td>

                    <td className="hidden px-5 py-4 sm:table-cell">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold ${customerTypeBadge(c.customer_type, 'dark')}`}>
                        {customerTypeLabel(c.customer_type)}
                      </span>
                    </td>

                    <td className="hidden px-5 py-4 font-mono text-sm text-v2-muted md:table-cell">
                      {c.phone ?? '—'}
                    </td>

                    <td className="hidden px-5 py-4 text-sm text-v2-muted lg:table-cell">
                      <span className="block max-w-[260px] truncate">{c.address ?? '—'}</span>
                    </td>

                    <td className="px-5 py-4">
                      {c.is_active ? (
                        <span className="inline-flex items-center rounded-full border border-emerald-500/30
                                         bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-300">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-v2-border
                                         bg-v2-raised px-2.5 py-1 text-sm font-semibold text-v2-muted">
                          Inactive
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modals / Drawer ──────────────────────────────────────── */}
      {creating && (
        <CustomerCreateModal
          onClose={() => setCreating(false)}
          onSaved={(created) => {
            setCreating(false);
            load(true);
            if (created?.id) setSelectedId(created.id);
          }}
        />
      )}

      {selectedId !== null && (
        <CustomerDetailDrawer
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onSaved={() => load(true)}
        />
      )}

      {mergeCandidate && (
        <CustomerMergeModal
          customer={mergeCandidate.from}
          initialTargetCustomer={mergeCandidate.to}
          onClose={() => setMergeCandidate(null)}
          onMerged={() => {
            setMergeCandidate(null);
            load(true);
          }}
        />
      )}

      {pickerVisible && (
        <PrinterPicker
          devices={pickerDevices}
          loading={pickerLoading}
          current={pickerCurrent}
          printPending={printPending}
          onSave={savePrinter}
          onScanWifi={scanWifi}
          onTestPrint={testPrint}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
