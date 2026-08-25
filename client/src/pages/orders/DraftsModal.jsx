import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Modal from '../../components/ui/Modal';
import { orderRef } from '../../utils/orderRef';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const listDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) : '—';

export default function DraftsModal({ onClose, onResume, onChanged, customers = [] }) {
  const { addToast } = useToast();

  const [drafts, setDrafts]               = useState([]);
  const [loading, setLoading]             = useState(true);
  const [query, setQuery]                 = useState('');
  const [busyId, setBusyId]               = useState(null);
  const [discardTarget, setDiscardTarget] = useState(null);
  const [discarding, setDiscarding]       = useState(false);
  const [bulkPrompt, setBulkPrompt]       = useState(false);
  const [bulkBusy, setBulkBusy]           = useState(false);

  const customerName = (o) =>
    o.customer_name || customers.find((c) => String(c.id) === String(o.customer_id))?.name || 'Customer';

  const load = async () => {
    setLoading(true);
    try {
      const rows = await api.get('/orders?status=draft');
      setDrafts(rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    } catch (err) {
      addToast(err.message || 'Failed to load drafts.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter(
      (o) => customerName(o).toLowerCase().includes(q)
        || String(o.id ?? '').includes(q)
        || String(o.receipt_number ?? '').toLowerCase().includes(q)
    );
  }, [drafts, query, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResume = async (o) => {
    setBusyId(o.id);
    try {
      const full = await api.get(`/orders/${o.id}`);
      onResume(full);
      onClose();
    } catch (err) {
      addToast(err.message || 'Failed to open the draft.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDiscardOne = async () => {
    if (!discardTarget) return;
    setDiscarding(true);
    try {
      await api.del(`/orders/${discardTarget.id}`);
      setDrafts((prev) => prev.filter((d) => d.id !== discardTarget.id));
      addToast('Draft discarded.', 'success');
      setDiscardTarget(null);
      onChanged?.();
    } catch (err) {
      addToast(err.message || 'Failed to discard draft.', 'error');
    } finally {
      setDiscarding(false);
    }
  };

  const handleDiscardAll = async () => {
    setBulkBusy(true);
    const results = await Promise.allSettled(visible.map((d) => api.del(`/orders/${d.id}`)));
    const done   = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - done;
    addToast(
      failed
        ? `Discarded ${done} draft${done === 1 ? '' : 's'}, ${failed} failed.`
        : `${done} draft${done === 1 ? '' : 's'} discarded.`,
      failed ? 'error' : 'success'
    );
    setBulkBusy(false);
    setBulkPrompt(false);
    load();
    onChanged?.();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drafts-modal-title"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden border border-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
            <div>
              <h2 id="drafts-modal-title" className="text-xl font-bold text-slate-900">
                📝 Parked Drafts
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {drafts.length} draft{drafts.length === 1 ? '' : 's'} saved
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close drafts"
              className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400
                         hover:text-slate-700 hover:bg-slate-100 transition-colors
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              ✕
            </button>
          </div>

          {/* Search + Bulk Action Toolbar */}
          <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 shrink-0 space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by customer or order number…"
                className="flex-1 h-11 px-4 border border-slate-300 rounded-xl text-sm text-slate-900 bg-white
                           focus:outline-none focus:ring-2 focus:ring-blue-600"
                aria-label="Search by customer or order number"
              />
              {visible.length > 0 && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setBulkPrompt(true)}
                  className="shrink-0"
                >
                  🗑 Discard all ({visible.length})
                </Button>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 min-h-0">
            {loading ? (
              <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
            ) : visible.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <p className="text-base font-semibold">No drafts found.</p>
                <p className="text-xs text-slate-400 mt-1">
                  {query ? 'Try a different search term.' : 'Orders you start and park will appear here.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {visible.map((o) => {
                  const busy = busyId === o.id || (discarding && discardTarget?.id === o.id) || bulkBusy;
                  return (
                    <li
                      key={o.id}
                      className="p-4 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-colors shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-base font-bold text-slate-900 truncate">
                            {orderRef(o)} · {customerName(o)}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Started {listDateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-800 border border-violet-200">
                              📝 Draft — not saved yet
                            </span>
                          </div>
                        </div>

                        <p className="text-lg font-bold text-slate-900 tabular-nums">
                          {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDiscardTarget(o)}
                          disabled={busy}
                        >
                          🗑 Discard
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleResume(o)}
                          disabled={busy}
                          loading={busyId === o.id}
                        >
                          ▶ Resume draft
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footnote */}
          <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 shrink-0">
            Drafts hold no stock and never print. Resuming one loads it into the New Order modal.
          </div>
        </div>
      </div>

      {/* Discard One Confirm */}
      {discardTarget && (
        <Modal
          title={`Discard draft ${orderRef(discardTarget)}?`}
          onClose={() => setDiscardTarget(null)}
          onConfirm={confirmDiscardOne}
          confirmLabel="Yes, discard draft"
          confirmVariant="danger"
          loading={discarding}
        >
          <p className="text-slate-600">
            The draft order for <strong>{customerName(discardTarget)}</strong> will be permanently removed.
            This cannot be undone.
          </p>
        </Modal>
      )}

      {/* Bulk Discard Confirm */}
      {bulkPrompt && (
        <Modal
          title={`Discard ${visible.length} draft${visible.length === 1 ? '' : 's'}?`}
          onClose={() => setBulkPrompt(false)}
          onConfirm={handleDiscardAll}
          confirmLabel={`Yes, discard ${visible.length} ${visible.length === 1 ? 'draft' : 'drafts'}`}
          confirmVariant="danger"
          loading={bulkBusy}
        >
          <p className="text-slate-600">
            This will permanently remove {visible.length === 1 ? 'this draft' : `all ${visible.length} drafts currently listed`}.
            This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
