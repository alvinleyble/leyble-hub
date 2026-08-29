import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OfflineBanner from '../../components/ui/OfflineBanner';
import PersonnelFormModal from './PersonnelFormModal';
import PersonnelDetailPanel from './PersonnelDetailPanel';
import { getCachedPersonnel, getCachedEntity } from '../../offline/catalogue.js';
import { checkIsOnline } from '../../offline/status.js';

export default function PersonnelPage() {
  const { addToast } = useToast();

  const [personnel, setPersonnel]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);
  const [fromCache, setFromCache]       = useState(false);

  // Offline fallback — Slice 3.2's catalogue sync already holds this device's copy of
  // personnel (client/src/offline/catalogue.js), the same cache OrderCreateModal reads
  // from; this page just never asked for it, so a blind tablet showed a blank table.
  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (showInactive) params.set('include_inactive', 'true');

    api.get(`/personnel?${params}`)
      .then((rows) => { setPersonnel(rows); setFromCache(false); })
      .catch(async () => {
        const cached = showInactive ? await getCachedEntity('personnel') : await getCachedPersonnel();
        if (cached.length === 0) {
          addToast('Offline and this device has no personnel roster yet — connect once to set it up.', 'error');
          return;
        }
        setPersonnel(cached);
        setFromCache(true);
      })
      .finally(() => setLoading(false));
  }, [showInactive, addToast]);

  useEffect(() => { load(); }, [load]);

  const mutationsBlocked = fromCache || !checkIsOnline();

  const filtered = personnel.filter((p) =>
    p.full_name.toLowerCase().includes(search.toLowerCase()) ||
    (p.remarks ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Personnel</h1>
        {/* ADR 0015 §9 — personnel is read-only offline: adding, editing, deactivating
            and photo upload all change a roster every device shares. */}
        <Button
          onClick={() => setCreating(true)}
          disabled={mutationsBlocked}
          title={mutationsBlocked ? 'Needs a connection' : undefined}
        >
          + Add Personnel
        </Button>
      </div>

      {fromCache && <OfflineBanner />}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                     focus:outline-none focus:ring-2 focus:ring-blue-600"
          aria-label="Search personnel"
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
      ) : filtered.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {search ? 'No personnel match your search.' : 'No personnel yet. Add someone to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Phone</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4">
                    <p className={`font-semibold ${p.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                      {p.full_name}
                    </p>
                  </td>
                  <td className="px-5 py-4 text-slate-500 hidden md:table-cell">
                    {p.phone ?? '—'}
                  </td>
                  <td className="px-5 py-4">
                    {p.is_active ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                        bg-green-100 text-green-800 border border-green-300">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                        bg-slate-100 text-slate-500 border border-slate-200">
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
        <PersonnelFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}

      {selectedId !== null && (
        <PersonnelDetailPanel
          personnelId={selectedId}
          onClose={() => setSelectedId(null)}
          onSaved={load}
          cachedPerson={personnel.find((p) => String(p.id) === String(selectedId)) || null}
        />
      )}
    </div>
  );
}
