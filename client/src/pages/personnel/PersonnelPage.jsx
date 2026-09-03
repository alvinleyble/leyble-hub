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
import { subscribeOutbox, queuedPersonnelFromOutbox, pendingPersonnelEditIds } from '../../offline/index.js';

export default function PersonnelPage() {
  const { addToast } = useToast();

  const [personnel, setPersonnel]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);
  const [fromCache, setFromCache]       = useState(false);
  // G3 — personnel added while blind, still queued in the outbox and not yet visible
  // to the server's own /personnel list. Mirrors CustomersPage's queuedCustomers.
  const [queuedPersonnel, setQueuedPersonnel] = useState([]);
  // An existing personnel record carrying an undrained offline EDIT, mirroring
  // CustomersPage.jsx's pendingEditIds for customers.
  const [pendingEditIds, setPendingEditIds] = useState(() => new Set());

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

  // Reads directly from the outbox rather than the server, so a person added or
  // edited offline shows up here immediately, and clears the moment the queued
  // record actually drains — no page reload, matching CustomersPage's G29/G7 pattern.
  const loadQueuedPersonnel = useCallback(async () => {
    const [created, editIds] = await Promise.all([
      queuedPersonnelFromOutbox(),
      pendingPersonnelEditIds(),
    ]);
    setQueuedPersonnel(created);
    setPendingEditIds(editIds);
  }, []);

  useEffect(() => {
    loadQueuedPersonnel();
    return subscribeOutbox(() => loadQueuedPersonnel());
  }, [loadQueuedPersonnel]);

  // 9.0/9.1/9.2 — delete, photo upload/delete, and the active/inactive toggle stay
  // online-only; the rest of the edit form and + Add Personnel no longer do (G3).
  const mutationsBlocked = fromCache || !checkIsOnline();

  const searchLower = search.toLowerCase();
  const visibleQueuedPersonnel = searchLower
    ? queuedPersonnel.filter((p) =>
        p.full_name.toLowerCase().includes(searchLower) ||
        (p.remarks ?? '').toLowerCase().includes(searchLower))
    : queuedPersonnel;
  const filtered = [
    ...visibleQueuedPersonnel,
    ...personnel.filter((p) =>
      p.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (p.remarks ?? '').toLowerCase().includes(search.toLowerCase())
    ),
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Personnel</h1>
        <Button onClick={() => setCreating(true)}>
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
          data-testid="personnel-search-input"
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
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="personnel-list">
          {/* Phone-width cards (D5) — same rows/testids as the table below, hidden at lg */}
          <div className="lg:hidden divide-y divide-slate-200">
            {filtered.map((p) => (
              <div
                key={p.id}
                onClick={() => {
                  if (p._unsynced) {
                    addToast('Personnel is queued for sync — details and editing will be available once connected.', 'info');
                    return;
                  }
                  setSelectedId(p.id);
                }}
                data-testid="personnel-row"
                className="p-4 active:bg-blue-50 cursor-pointer flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className={`font-semibold truncate ${p.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                    {p.full_name}
                  </p>
                  <p className="text-sm text-slate-500 mt-0.5">{p.phone ?? '—'}</p>
                </div>
                {(p._unsynced || pendingEditIds.has(String(p.id))) ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                    bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                    ⏳ Waiting to sync
                  </span>
                ) : p.is_active ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                    bg-green-100 text-green-800 border border-green-300 shrink-0">
                    Active
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                    bg-slate-100 text-slate-500 border border-slate-200 shrink-0">
                    Inactive
                  </span>
                )}
              </div>
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
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
                  onClick={() => {
                    // A still-queued personnel record has no server row yet: opening
                    // the edit panel would 404 against a `local-` id, so tell the
                    // operator why instead of trying (mirrors CustomersPage's G29).
                    if (p._unsynced) {
                      addToast('Personnel is queued for sync — details and editing will be available once connected.', 'info');
                      return;
                    }
                    setSelectedId(p.id);
                  }}
                  data-testid="personnel-row"
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
                    {(p._unsynced || pendingEditIds.has(String(p.id))) ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                                        bg-amber-100 text-amber-800 border border-amber-300">
                        ⏳ Waiting to sync
                      </span>
                    ) : p.is_active ? (
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
