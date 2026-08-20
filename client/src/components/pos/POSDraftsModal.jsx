import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../ui/Toast';
import POSListModal, { LIST_ACTION_BTN, LIST_ROW, listDateTime } from './POSListModal';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Orders still in `draft` — started on the POS and auto-saved, but never finalized.
// They are deliberately absent from History (proposal §2.1), so this is the one place
// an unfinished order can be found again. Resuming one puts it back on the POS with
// its draft id intact, so saving it finalizes that same order rather than making a new
// one. Same list/row styling as History (POSListModal).
export default function POSDraftsModal({ onClose, onResume }) {
  const { addToast } = useToast();

  const [drafts, setDrafts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');
  const [busyId, setBusyId]   = useState(null);

  useEffect(() => {
    api.get('/orders?status=draft')
      .then((rows) => setDrafts(rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))))
      .catch((err) => addToast(err.message || 'Failed to load drafts.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter(
      (o) => (o.customer_name || '').toLowerCase().includes(q) || String(o.id).includes(q)
    );
  }, [drafts, query]);

  const resume = async (id) => {
    setBusyId(id);
    try {
      onResume(await api.get(`/orders/${id}`));
    } catch (err) {
      addToast(err.message || 'Failed to open the draft.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <POSListModal
      id="pos-drafts"
      title="📝 Drafts"
      closeLabel="Close drafts"
      searchLabel="Search by customer or order number"
      query={query}
      onQueryChange={setQuery}
      loading={loading}
      loadingText="Loading drafts…"
      isEmpty={visible.length === 0}
      emptyText="No drafts. An order you start stays here until you save it."
      footnote="Drafts hold no stock and never print. Resuming one puts it back on the POS — saving it there turns that same draft into a Created order."
      onClose={onClose}
    >
      {visible.map((o) => (
        <li key={o.id} className={LIST_ROW}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-bold text-v2-text">
                #{o.id} · {o.customer_name}
              </p>
              <p className="text-base text-v2-muted">
                Started {listDateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-lg bg-v2-raised px-2 py-1 text-sm font-bold text-v2-muted">
                  📝 Draft — not saved yet
                </span>
              </div>
            </div>

            <p className="text-right text-xl font-black tabular-nums text-v2-text">
              {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busyId === o.id}
              onClick={() => resume(o.id)}
              className={`${LIST_ACTION_BTN} bg-v2-accent-strong text-white hover:bg-v2-accent`}
            >
              ▶ Resume draft
            </button>
          </div>
        </li>
      ))}
    </POSListModal>
  );
}
