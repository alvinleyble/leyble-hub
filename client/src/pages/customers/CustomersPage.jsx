import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import CustomerFormModal from './CustomerFormModal';
import CustomerDetailPanel from './CustomerDetailPanel';
import BluetoothPrinterPicker from '../orders/BluetoothPrinterPicker';
import { usePrintList } from '../shared/usePrintList';
import { customerListHtml } from '../shared/listPrintTemplate';
import { customerListEscPos } from '../shared/listEscPos';

const TYPE_BADGE = {
  regular:    'bg-slate-100 text-slate-600 border-slate-200',
  wholesaler: 'bg-amber-100 text-amber-800 border-amber-300',
};

export default function CustomersPage() {
  const { addToast } = useToast();

  const [customers, setCustomers]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);

  // Debounce search so we don't fire on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (showInactive) params.set('include_inactive', 'true');
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());

    api.get(`/customers?${params}`)
      .then(setCustomers)
      .catch(() => addToast('Failed to load customers', 'error'))
      .finally(() => setLoading(false));
  }, [showInactive, debouncedSearch, addToast]);

  useEffect(() => { load(); }, [load]);

  const {
    printList, printing,
    pickerVisible, pickerDevices, pickerLoading, handlePrinterSelected, closePicker,
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
      ) : customers.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {search ? 'No customers match your search.' : 'No customers yet. Add one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-200">
                <th className="text-left px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-5 py-3 font-semibold hidden sm:table-cell">Type</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Phone</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Address</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="border-t border-slate-100 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4">
                    <p className={`font-semibold ${c.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                      {c.name}
                    </p>
                  </td>
                  <td className="px-5 py-4 hidden sm:table-cell">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border ${TYPE_BADGE[c.customer_type]}`}>
                      {c.customer_type === 'wholesaler' ? 'Wholesalers' : 'Regular Customer'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-500 hidden md:table-cell">
                    {c.phone ?? '—'}
                  </td>
                  <td className="px-5 py-4 text-slate-500 text-sm hidden lg:table-cell">
                    <span className="block max-w-[220px] truncate">{c.address ?? '—'}</span>
                  </td>
                  <td className="px-5 py-4">
                    {c.is_active ? (
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
          onSaved={() => { setCreating(false); load(); }}
        />
      )}

      {selectedId !== null && (
        <CustomerDetailPanel
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onSaved={load}
        />
      )}

      {pickerVisible && (
        <BluetoothPrinterPicker
          devices={pickerDevices}
          loading={pickerLoading}
          onSelect={handlePrinterSelected}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
