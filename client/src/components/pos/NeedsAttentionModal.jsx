import React, { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../../api/client';
import { listNeedsAttention, repointRecord } from '../../offline/outbox';
import { useToast } from '../ui/Toast';
import Spinner from '../ui/Spinner';
import { customerMatches } from '../../utils/customerSearch';

const PHP = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD = `w-full h-11 rounded-lg border border-v2-border bg-v2-bg px-3 text-base text-v2-text
               placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

function formatRefusalReason(lastError) {
  const err = String(lastError || '').toLowerCase();
  if (err.includes('customer') || err.includes('not found') || err.includes('inactive')) {
    return 'This customer was merged or deactivated on the server — select destination customer to assign.';
  }
  if (err.includes('product') || err.includes('sku')) {
    return 'A product in this order was modified or removed on the server — review and re-point.';
  }
  return `Server refused this receipt: ${lastError || 'Unknown validation error'} — select customer to re-point.`;
}

// D8 — Attention list for refused receipts.
//
// When a receipt is refused by the server (e.g. customer merged while offline),
// it lands in this list. The store owner points it at the right record in a couple
// of taps.
//
// Invariants:
// - Never discard, never auto-resolve.
export default function NeedsAttentionModal({ onClose }) {
  const { addToast } = useToast();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);

  // Per-record selected target customer and query state: { [recordId]: customer }
  const [selectedTargets, setSelectedTargets] = useState({});
  const [queries, setQueries] = useState({});
  const [openDropdownId, setOpenDropdownId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const blurTimerRef = useRef(null);

  const loadAttentionList = async () => {
    setLoading(true);
    try {
      const list = await listNeedsAttention();
      setRecords(list);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAttentionList();
    api.get('/customers')
      .then((data) => {
        const active = (data || []).filter((c) => c.is_active);
        setCustomers(active);
      })
      .catch(() => {})
      .finally(() => setLoadingCustomers(false));
  }, []);

  const closeSoon = () => {
    blurTimerRef.current = setTimeout(() => setOpenDropdownId(null), 150);
  };
  const cancelClose = () => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  };

  const handleSelectCustomer = (recordId, customer) => {
    setSelectedTargets((prev) => ({ ...prev, [recordId]: customer }));
    setQueries((prev) => ({ ...prev, [recordId]: '' }));
    setOpenDropdownId(null);
  };

  const handleRepoint = async (record) => {
    const target = selectedTargets[record.id];
    if (!target) return;

    setSavingId(record.id);
    try {
      await repointRecord(record.id, { customerId: target.id });
      addToast(`Receipt ${record.receipt_number || record.id} re-pointed to ${target.name} and queued to sync.`, 'success');
      const updated = await listNeedsAttention();
      setRecords(updated);
      if (updated.length === 0) {
        onClose?.();
      }
    } catch (err) {
      addToast(err.message || 'Failed to re-point receipt.', 'error');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attention-list-title"
      onClick={(e) => { if (e.target === e.currentTarget && !savingId) onClose?.(); }}
    >
      <div className="my-8 flex w-full max-w-2xl flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚠️</span>
            <h2 id="attention-list-title" className="text-xl font-bold text-v2-text">
              Receipts Needing Attention ({records.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={savingId !== null}
            className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text disabled:opacity-40
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5 max-h-[75vh]">
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner size="md" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-12 text-center text-v2-muted">
              <p className="text-base font-semibold text-v2-text">No receipts need attention.</p>
              <p className="mt-1 text-sm">All offline receipts have successfully synced or are queued.</p>
            </div>
          ) : (
            records.map((rec) => {
              const query = queries[rec.id] || '';
              const matchedCustomers = customers.filter((c) => customerMatches(c, query)).slice(0, 30);
              const target = selectedTargets[rec.id];
              const isDropdownOpen = openDropdownId === rec.id;
              const items = rec.payload?.items || [];
              const total = items.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unit_price || 0)), 0);

              return (
                <div
                  key={rec.id}
                  className="rounded-xl border border-amber-500/30 bg-v2-bg p-4 space-y-3"
                >
                  {/* Top Bar of Record */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base font-black text-amber-300">
                        {rec.receipt_number || `#${rec.id}`}
                      </span>
                      <span className="rounded bg-v2-raised px-2 py-0.5 text-xs text-v2-muted font-medium">
                        Saved by: {rec.profile_key || 'Unknown'}
                      </span>
                    </div>
                    <div className="text-xs text-v2-muted">
                      {new Date(rec.created_at).toLocaleString('en-PH', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                      })}
                      {total > 0 && ` · ${PHP(total)} (${items.length} ${items.length === 1 ? 'item' : 'items'})`}
                    </div>
                  </div>

                  {/* Plain-English Reason Banner */}
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-sm font-semibold text-amber-200">
                    {formatRefusalReason(rec.last_error)}
                  </div>

                  {/* Re-point Customer Picker */}
                  <div className="space-y-2">
                    <label className="block text-xs font-bold uppercase tracking-wider text-v2-muted">
                      Assign to Active Customer:
                    </label>

                    {target ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/20 p-2.5">
                        <div className="min-w-0">
                          <span className="font-bold text-sm text-emerald-200">{target.name}</span>
                          <span className="ml-2 font-mono text-xs text-v2-muted">#{target.id}</span>
                          {target.address && (
                            <span className="block truncate text-xs text-v2-muted">{target.address}</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedTargets((prev) => ({ ...prev, [rec.id]: null }))}
                          disabled={savingId === rec.id}
                          className="h-8 rounded bg-v2-raised px-2.5 text-xs font-bold text-v2-text hover:bg-v2-border"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="relative">
                        <input
                          type="text"
                          value={query}
                          onChange={(e) => {
                            setQueries((prev) => ({ ...prev, [rec.id]: e.target.value }));
                            setOpenDropdownId(rec.id);
                          }}
                          onFocus={() => {
                            cancelClose();
                            setOpenDropdownId(rec.id);
                          }}
                          onBlur={closeSoon}
                          placeholder={loadingCustomers ? 'Loading customers…' : 'Search destination customer…'}
                          disabled={loadingCustomers || savingId === rec.id}
                          className={FIELD}
                        />

                        {isDropdownOpen && (
                          <ul
                            role="listbox"
                            className="absolute left-0 right-0 z-30 mt-1 max-h-48 overflow-y-auto rounded-xl border border-v2-border
                                       bg-v2-surface shadow-2xl"
                          >
                            {matchedCustomers.length === 0 ? (
                              <li className="px-3 py-2 text-xs text-v2-muted">No active customers found.</li>
                            ) : (
                              matchedCustomers.map((c) => (
                                <li key={c.id}>
                                  <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => handleSelectCustomer(rec.id, c)}
                                    className="flex min-h-[40px] w-full items-center justify-between px-3 py-2 text-left text-xs
                                               hover:bg-v2-raised focus-visible:outline-none"
                                  >
                                    <span className="font-semibold text-v2-text">{c.name}</span>
                                    <span className="font-mono text-v2-muted">#{c.id}</span>
                                  </button>
                                </li>
                              ))
                            )}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end pt-1">
                    <button
                      type="button"
                      disabled={!target || savingId === rec.id}
                      onClick={() => handleRepoint(rec)}
                      className="flex min-h-[44px] items-center gap-2 rounded-xl bg-amber-600 px-5 text-sm font-bold
                                 text-white hover:bg-amber-500 disabled:opacity-40 shadow-sm
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                    >
                      {savingId === rec.id ? 'Re-pointing…' : 'Confirm & Re-point'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end border-t border-v2-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                       font-bold text-v2-text hover:bg-v2-border focus-visible:outline-none"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
