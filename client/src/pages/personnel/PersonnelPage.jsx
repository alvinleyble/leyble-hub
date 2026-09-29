import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Page from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import SearchFilterBar from '../../components/ui/SearchFilterBar';
import ListCard from '../../components/ui/ListCard';
import { TagBadge } from '../../components/ui/Badge';
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
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (showInactive) params.set('include_inactive', 'true');

    return api.get(`/personnel?${params}`)
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
      .finally(() => { if (!silent) setLoading(false); });
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

  // Pull-down / re-tapping the menu item: reload quietly behind the rows on screen.
  useRefreshListener(() => Promise.all([load({ silent: true }), loadQueuedPersonnel()]));

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

  const openPerson = (p) => {
    // A still-queued personnel record has no server row yet: opening the edit panel
    // would 404 against a `local-` id, so tell the operator why instead of trying
    // (mirrors CustomersPage's G29).
    if (p._unsynced) {
      addToast('Personnel is queued for sync — details and editing will be available once connected.', 'info');
      return;
    }
    setSelectedId(p.id);
  };

  const statusBadge = (p) => ((p._unsynced || pendingEditIds.has(String(p.id)))
    ? <TagBadge kind="unsynced" />
    : p.is_active ? <TagBadge kind="active" /> : <TagBadge kind="inactive" />);

  return (
    <Page>
      <PageHeader title="Personnel" primary={{ label: '+ Add Personnel', onClick: () => setCreating(true) }} />

      {fromCache && <OfflineBanner />}

      {/* Search + Filters (Q3) — "Show inactive" in the panel (UI audit F6). */}
      <SearchFilterBar
        className="mb-4 md:mb-6"
        value={search}
        onChange={setSearch}
        placeholder="Name"
        ariaLabel="Search personnel"
        testId="personnel-search-input"
        active={showInactive ? [{ key: 'inactive', label: 'Showing inactive', onRemove: () => setShowInactive(false) }] : []}
        panel={(
          <label className="flex items-center gap-3 min-h-[48px] cursor-pointer select-none">
            <input
              type="checkbox" checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="w-6 h-6 accent-blue-700"
            />
            <span className="text-base text-slate-800 font-medium">Show inactive personnel</span>
          </label>
        )}
      />

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {search ? 'No personnel match your search.' : 'No personnel yet. Add someone to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="personnel-list">
          {/* Phone + upright-tablet rows (D5; tables from 1024px). Personnel keeps its
              previous row (round-8 grill): name, mobile or an em dash, and the one
              status badge on the right — Waiting to sync, Active or Inactive. */}
          <div className="lg:hidden divide-y divide-slate-200">
            {filtered.map((p) => (
              <ListCard
                key={p.id}
                onClick={() => openPerson(p)}
                data-testid="personnel-row"
                title={<span className={p.is_active ? '' : 'text-slate-500 line-through'}>{p.full_name}</span>}
                meta={p.phone || '—'}
                aside={statusBadge(p)}
              />
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Phone</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => openPerson(p)}
                  data-testid="personnel-row"
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 lg:px-5 py-4">
                    <p className={`font-semibold ${p.is_active ? 'text-slate-900' : 'text-slate-500 line-through'}`}>
                      {p.full_name}
                    </p>
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-slate-600">
                    {p.phone || '—'}
                  </td>
                  <td className="px-4 lg:px-5 py-4">{statusBadge(p)}</td>
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
    </Page>
  );
}
