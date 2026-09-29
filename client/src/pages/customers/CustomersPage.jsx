import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Page from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import SearchFilterBar from '../../components/ui/SearchFilterBar';
import ListCard from '../../components/ui/ListCard';
import { TagBadge } from '../../components/ui/Badge';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
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


// Matches the customer table's columns (Name, Type, Phone, Address, Status) and its
// phone-card twin below it.
function CustomersTableSkeleton() {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <SkeletonGroup label="Loading customers" className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="lg:hidden divide-y divide-slate-200">
        {rows.map((i) => (
          <div key={i} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full shrink-0" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full mt-3" />
          </div>
        ))}
      </div>

      <table className="hidden lg:table w-full text-base">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-400">
            <th className="px-5 py-3"><Skeleton className="h-3 w-16" /></th>
            <th className="px-5 py-3 hidden sm:table-cell"><Skeleton className="h-3 w-10" /></th>
            <th className="px-5 py-3 hidden lg:table-cell"><Skeleton className="h-3 w-14" /></th>
            <th className="px-5 py-3 hidden lg:table-cell"><Skeleton className="h-3 w-16" /></th>
            <th className="px-5 py-3"><Skeleton className="h-3 w-12" /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i} className="border-t border-slate-300">
              <td className="px-5 py-4"><Skeleton className="h-4 w-36" /></td>
              <td className="px-5 py-4 hidden sm:table-cell"><Skeleton className="h-5 w-16 rounded-full" /></td>
              <td className="px-5 py-4 hidden lg:table-cell"><Skeleton className="h-4 w-24" /></td>
              <td className="px-5 py-4 hidden lg:table-cell"><Skeleton className="h-4 w-40" /></td>
              <td className="px-5 py-4"><Skeleton className="h-5 w-16 rounded-full" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonGroup>
  );
}

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

    return api.get(`/customers?${params}`)
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

  // Pull-down / re-tapping the menu item: reload quietly behind the rows on screen.
  useRefreshListener(() => Promise.all([load(true), loadQueuedCustomers()]));

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

  const openCustomer = (c) => {
    // G29 — a still-queued customer has no server row yet: opening the edit drawer
    // would 404/500 against a `local-` id, so tell the operator why instead of trying.
    if (c._unsynced) {
      addToast('Customer is queued for sync — details and editing will be available once connected.', 'info');
      return;
    }
    setSelectedId(c.id);
  };

  // Customers badges every row Active or Inactive (round-8 grill, the captain's call
  // over Q6's "only when unusual"); a queued edit adds Waiting to sync beside it.
  const activeBadge = (c) => <TagBadge kind={c.is_active ? 'active' : 'inactive'} />;
  const syncBadge = (c) => (c._unsynced || pendingEditIds.has(String(c.id))) && <TagBadge key="sync" kind="unsynced" />;
  const orDash = (v) => (v == null || String(v).trim() === '' ? '—' : v);

  const typeBadge = (c) => (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap ${customerTypeBadge(c.customer_type)}`}>
      {customerTypeLabel(c.customer_type)}
    </span>
  );

  return (
    <Page>
      <PageHeader
        title="Customers"
        primary={{ label: '+ Add Customer', shortLabel: '+ Add', onClick: () => setCreating(true) }}
        actions={[{
          label: 'Print List', icon: 'printer', onClick: handlePrintList, loading: printing,
          disabled: customers.length === 0,
        }]}
      />

      {/* Search + Filters (Q3): "Show inactive" is in the Filters panel, not beside
          the search box where it was pushed off a 360px screen (UI audit F6). */}
      <SearchFilterBar
        className="mb-4 md:mb-6"
        value={search}
        onChange={setSearch}
        placeholder="Name or phone"
        ariaLabel="Search customers"
        testId="customers-search-input"
        active={showInactive ? [{ key: 'inactive', label: 'Showing inactive', onRemove: () => setShowInactive(false) }] : []}
        panel={(
          <label className="flex items-center gap-3 min-h-[48px] cursor-pointer select-none">
            <input
              type="checkbox" checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="w-6 h-6 accent-blue-700"
            />
            <span className="text-base text-slate-800 font-medium">Show inactive customers</span>
          </label>
        )}
      />

      {/* Table */}
      {loading ? (
        <CustomersTableSkeleton />
      ) : displayCustomers.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {search ? 'No customers match your search.' : 'No customers yet. Add one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="customers-list">
          {/* Phone + upright-tablet rows (D5; tables from 1024px), round-8 grill:
              line 1 name + type, line 2 mobile · address (an em dash for each blank)
              with the Active/Inactive badge. Same testids as the table. */}
          <div className="lg:hidden divide-y divide-slate-200">
            {displayCustomers.map((c) => (
              <ListCard
                key={c.id}
                onClick={() => openCustomer(c)}
                data-testid="customers-row"
                title={<span className={c.is_active ? '' : 'text-slate-500 line-through'}>{c.name}</span>}
                titleRight={typeBadge(c)}
                meta={`${orDash(c.phone)} · ${orDash(c.address)}`}
                metaRight={activeBadge(c)}
                badges={[syncBadge(c)]}
              />
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Type</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Phone</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">Address</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {displayCustomers.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => openCustomer(c)}
                  data-testid="customers-row"
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 lg:px-5 py-4">
                    <p className={`font-semibold ${c.is_active ? 'text-slate-900' : 'text-slate-500 line-through'}`}>
                      {c.name}
                    </p>
                  </td>
                  <td className="px-4 lg:px-5 py-4">{typeBadge(c)}</td>
                  <td className="px-4 lg:px-5 py-4 text-slate-600 whitespace-nowrap">
                    {orDash(c.phone)}
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-slate-600 text-sm hidden lg:table-cell">
                    <span className="block max-w-[220px] truncate">{orDash(c.address)}</span>
                  </td>
                  <td className="px-4 lg:px-5 py-4">
                    {(c._unsynced || pendingEditIds.has(String(c.id))) ? (
                      <TagBadge kind="unsynced" />
                    ) : c.is_active ? (
                      <TagBadge kind="active" />
                    ) : (
                      <TagBadge kind="inactive" />
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
    </Page>
  );
}
