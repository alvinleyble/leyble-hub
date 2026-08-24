import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../ui/Toast';
import POSConfirm from './POSConfirm';
import POSListModal, { LIST_ACTION_BTN, LIST_ROW, listDateTime } from './POSListModal';
import { orderRef } from '../../utils/orderRef';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import {
  listLocalParkedOrders, mergeParkedOrders, isDraftUnsynced, discardLocalDraft, queueOrderDeletion,
  pendingDeletionRefs, subscribeOutbox,
} from '../../offline/index.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Orders still in `draft` — started on the POS and auto-saved, but never finalized.
// They are deliberately absent from History (proposal §2.1), so this is the one place
// an unfinished order can be found again. Resuming one puts it back on the POS with
// its draft id intact, so saving it finalizes that same order rather than making a new
// one. Same list/row styling as History (POSListModal).
//
// D6 — with the switch on, the list is the union of what the server holds (when
// reachable) and what this tablet holds locally: a draft parked during an outage
// (POSPage.jsx's early-draft effect) lives only in the outbox until it syncs, at
// which point it disappears from the local half and the server's own copy — now
// visible via GET /orders?status=draft — is the only one left. `_outboxId` on a row
// marks it as still-local; `receipt_number` is its identity either way.
export default function POSDraftsModal({ onClose, onResume, onChanged, customers = [] }) {
  const { addToast } = useToast();

  const [drafts, setDrafts]               = useState([]);
  const [loading, setLoading]             = useState(true);
  const [query, setQuery]                 = useState('');
  const [busyId, setBusyId]               = useState(null);
  const [discardTarget, setDiscardTarget] = useState(null);
  const [discarding, setDiscarding]       = useState(false);
  const [bulkPrompt, setBulkPrompt]       = useState(false);
  const [bulkBusy, setBulkBusy]           = useState(false);

  const customerName = (o) => o.customer_name || customers.find((c) => String(c.id) === String(o.customer_id))?.name || 'Customer';

  const load = async () => {
    setLoading(true);
    if (!V25_OFFLINE_CORE) {
      api.get('/orders?status=draft')
        .then((rows) => setDrafts(rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))))
        .catch((err) => addToast(err.message || 'Failed to load drafts.', 'error'))
        .finally(() => setLoading(false));
      return;
    }

    const [localDrafts, pendingDeletions] = await Promise.all([
      listLocalParkedOrders().catch(() => []),
      pendingDeletionRefs().catch(() => new Set()),
    ]);
    try {
      const serverDrafts = await api.get('/orders?status=draft');
      setDrafts(mergeParkedOrders(serverDrafts, localDrafts, pendingDeletions));
    } catch {
      // Blind — the server's own drafts are unreachable, so only this tablet's local
      // parks show, exactly as D6 describes.
      setDrafts(localDrafts);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Same reasoning as POSPage.jsx: reload if the outbox changes while this list is
  // open (a queued cleanup lands, or a drain finishes) rather than showing a stale
  // list until the modal is closed and reopened.
  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    return subscribeOutbox(() => { load(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter(
      (o) => customerName(o).toLowerCase().includes(q)
        || String(o.id ?? '').includes(q)
        || String(o.receipt_number ?? '').toLowerCase().includes(q)
    );
  }, [drafts, query, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowKey = (o) => o.receipt_number || o.id;

  const resume = async (o) => {
    const key = rowKey(o);
    setBusyId(key);
    try {
      if (V25_OFFLINE_CORE && o._outboxId) {
        // Still only local — nothing to fetch, resume the copy already held.
        onResume(o);
        return;
      }
      onResume(await api.get(`/orders/${o.id}`));
    } catch (err) {
      addToast(err.message || 'Failed to open the draft.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const discardOne = async (o) => {
    const ref = o.receipt_number || o.id;
    if (V25_OFFLINE_CORE && o._outboxId && (await isDraftUnsynced(o.receipt_number))) {
      await discardLocalDraft(o.receipt_number);
      return;
    }
    try {
      await api.del(`/orders/${ref}`);
    } catch (err) {
      if (V25_OFFLINE_CORE && !err?.status) {
        // Blind, and this draft exists on the server — queue the delete so it still
        // lands once the line returns (D6/D13); a repeat arrival is harmless.
        await queueOrderDeletion({ orderRef: ref, profileKey: await api.getActiveProfile() });
      } else {
        throw err;
      }
    }
  };

  const confirmDiscard = async () => {
    if (!discardTarget) return;
    setDiscarding(true);
    try {
      await discardOne(discardTarget);
      setDrafts((prev) => prev.filter((d) => rowKey(d) !== rowKey(discardTarget)));
      addToast('Draft discarded.', 'success');
      setDiscardTarget(null);
      onChanged?.();
    } catch (err) {
      addToast(err.message || 'Failed to discard draft.', 'error');
    } finally {
      setDiscarding(false);
    }
  };

  const discardAll = async () => {
    setBulkBusy(true);
    const results = await Promise.allSettled(visible.map((d) => discardOne(d)));
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
      <POSListModal
        id="pos-drafts"
        title="📝 Drafts"
        closeLabel="Close drafts"
        searchLabel="Search by customer or order number"
        query={query}
        onQueryChange={setQuery}
        filters={
          visible.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setBulkPrompt(true)}
                className={`${LIST_ACTION_BTN} bg-red-700 text-white hover:bg-red-600`}
              >
                🗑️ Discard all {visible.length} {visible.length === 1 ? 'draft' : 'drafts'}
              </button>
            </div>
          ) : null
        }
        loading={loading}
        loadingText="Loading drafts…"
        isEmpty={visible.length === 0}
        emptyText="No drafts. An order you start stays here until you save it."
        footnote="Drafts hold no stock and never print. Resuming one puts it back on the POS — saving it there turns that same draft into a Created order."
        onClose={onClose}
      >
        {visible.map((o) => {
          const key = rowKey(o);
          const busy = busyId === key || (discarding && discardTarget && rowKey(discardTarget) === key) || bulkBusy;
          return (
          <li key={key} className={LIST_ROW}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-bold text-v2-text">
                  {orderRef(o)} · {customerName(o)}
                </p>
                <p className="text-base text-v2-muted">
                  Started {listDateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-lg bg-v2-raised px-2 py-1 text-sm font-bold text-v2-muted">
                    📝 Draft — not saved yet
                  </span>
                  {o._outboxId && (
                    <span className="rounded-lg bg-amber-500/15 px-2 py-1 text-sm font-bold text-amber-200">
                      📴 Parked on this tablet — will sync when back online
                    </span>
                  )}
                </div>
              </div>

              <p className="text-right text-xl font-black tabular-nums text-v2-text">
                {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
              </p>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => resume(o)}
                className={`${LIST_ACTION_BTN} bg-v2-accent-strong text-white hover:bg-v2-accent`}
              >
                ▶ Resume draft
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDiscardTarget(o)}
                className={`${LIST_ACTION_BTN} bg-red-700 text-white hover:bg-red-600`}
              >
                🗑️ Discard
              </button>
            </div>
          </li>
          );
        })}
      </POSListModal>

      {discardTarget && (
        <POSConfirm
          title={`Discard draft ${orderRef(discardTarget)}?`}
          confirmLabel="Yes, discard draft"
          cancelLabel="Keep it"
          danger
          loading={discarding}
          onConfirm={confirmDiscard}
          onClose={() => setDiscardTarget(null)}
        >
          The draft order for <strong className="text-v2-text">{customerName(discardTarget)}</strong> will be
          permanently removed. It cannot be undone.
        </POSConfirm>
      )}

      {bulkPrompt && (
        <POSConfirm
          title={`Discard ${visible.length} draft${visible.length === 1 ? '' : 's'}?`}
          confirmLabel={`Yes, discard ${visible.length} ${visible.length === 1 ? 'draft' : 'drafts'}`}
          cancelLabel="Keep them"
          danger
          loading={bulkBusy}
          onConfirm={discardAll}
          onClose={() => setBulkPrompt(false)}
        >
          This permanently removes {visible.length === 1 ? 'this draft' : `all ${visible.length} drafts currently listed`}. It cannot be undone.
        </POSConfirm>
      )}
    </>
  );
}
