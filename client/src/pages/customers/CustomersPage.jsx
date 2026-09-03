import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import CustomerFormModal from './CustomerFormModal';
import CustomerDetailPanel from './CustomerDetailPanel';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintList } from '../shared/usePrintList';
import { customerListHtml } from '../shared/listPrintTemplate';
import { customerListEscPos } from '../shared/listEscPos';
import { customerTypeBadge, customerTypeLabel } from '../../utils/customerTypes';
import { subscribeOutbox, queuedCustomersFromOutbox, pendingCustomerEditIds } from '../../offline/index.js';
import { getCachedCustomers, getCachedEntity } from '../../offline/catalogue.js';
import { customerMatches } from '../../utils/customerSearch';


export default function CustomersPage() {
  const { addToast } = useToast();

  const [customers, setCustomers]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);
  // G29 — customers quick-created offline (OrderCreateModal), still queued in the
  // outbox and not yet visible to the server's own /customers list.
  const [queuedCustomers, setQueuedCustomers] = useState([]);
  // G7 — an existing customer carrying an undrained offline EDIT, mirroring
  // InventoryPage.jsx's pendingEditIds for products.
  const [pendingEditIds, setPendingEditIds] = useState(() => new Set());

  // Debounce search so we don't fire on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Offline fallback — Slice 3.2's catalogue sync already holds this device's copy of
  // customers (client/src/offline/catalogue.js), the same cache OrderCreateModal reads
  // from; this page just never asked for it, so a blind tablet showed a blank table.
  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (showInactive) params.set('include_inactive', 'true');
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());

    api.get(`/customers?${params}`)
      .then(setCustomers)
      .catch(async () => {
        const cached = showInactive ? await getCachedEntity('customers') : await getCachedCustomers();
        if (cached.length === 0) {
          addToast('Offline and this device has no customer directory yet — connect once to set it up.', 'error');
          return;
        }
        setCustomers(debouncedSearch.trim()
          ? cached.filter((c) => customerMatches(c, debouncedSearch))
          : cached);
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [showInactive, debouncedSearch, addToast]);

  useEffect(() => { load(); }, [load]);

  // G29 — Cross-App Visibility. Reads directly from the outbox rather than the
  // server, so a customer quick-created offline shows up here immediately, and
  // disappears the moment its queued POST /customers actually drains — no page
  // reload, no spinner, matching the same silent-refresh spirit as G27.
  const loadQueuedCustomers = useCallback(async () => {
    const [created, editIds] = await Promise.all([
      queuedCustomersFromOutbox(),
      pendingCustomerEditIds(),
    ]);
    setQueuedCustomers(created);
    setPendingEditIds(editIds);
  }, []);

  useEffect(() => {
    loadQueuedCustomers();
    return subscribeOutbox(() => loadQueuedCustomers());
  }, [loadQueuedCustomers]);

  const searchLower = debouncedSearch.trim().toLowerCase();
  const visibleQueuedCustomers = searchLower
    ? queuedCustomers.filter((c) => c.name.toLowerCase().includes(searchLower))
    : queuedCustomers;
  const displayCustomers = [...visibleQueuedCustomers, ...customers];

  const {
    printList, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePicker,
  } = usePrintList();

  const handlePrintList = () => printList(customerListHtml(customers), customerListEscPos(customers));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handlePrintList} loading={printing} disabled={customers.length === 0}>
            🖶 Print List
          </Button>
          <Button onClick={() => setCreating(true)}>+ Add Customer</Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder="Search by name or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                     focus:outline-none focus:ring-2 focus:ring-blue-600"
          aria-label="Search customers"
          data-testid="customers-search-input"
        />
        <label className="flex items-center gap-3 h-12 px-4 border border-slate-300 rounded-lg
                          bg-white cursor-pointer select-none">
          <input
            type="checkbox" checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="w-6 h-6 accent-blue-700"
          />
          <span className="text-base text-slate-700 font-medium whitespace-nowrap">Show inactive</span>
        </label>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : displayCustomers.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {search ? 'No customers match your search.' : 'No customers yet. Add one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="customers-list">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-5 py-3 font-semibold hidden sm:table-cell">Type</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Phone</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Address</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {displayCustomers.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => {
                    // G29 — a still-queued customer has no server row yet: opening the
                    // edit drawer would 404/500 against a `local-` id, so tell the
                    // operator why instead of trying.
                    if (c._unsynced) {
                      addToast('Customer is queued for sync — details and editing will be available once connected.', 'info');
                      return;
                    }
                    setSelectedId(c.id);
                  }}
                  data-testid="customers-row"
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4">
                    <p className={`font-semibold ${c.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                      {c.name}
                    </p>
                  </td>
                  <td className="px-5 py-4 hidden sm:table-cell">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border ${customerTypeBadge(c.customer_type)}`}>
                      {customerTypeLabel(c.customer_type)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-500 hidden md:table-cell">
                    {c.phone ?? '—'}
                  </td>
                  <td className="px-5 py-4 text-slate-500 text-sm hidden lg:table-cell">
                    <span className="block max-w-[220px] truncate">{c.address ?? '—'}</span>
                  </td>
                  <td className="px-5 py-4">
                    {(c._unsynced || pendingEditIds.has(String(c.id))) ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                        ⏳ Waiting to sync
                      </span>
                    ) : c.is_active ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-green-100 text-green-800 border border-green-300">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-500 border border-slate-200">
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

      {creating && (
        <CustomerFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(true); }}
        />
      )}

      {selectedId !== null && (
        <CustomerDetailPanel
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onSaved={() => load(true)}
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
