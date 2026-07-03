import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function TicketDetailPanel({ ticketId, onClose, onResolved }) {
  const { addToast } = useToast();

  const [ticket, setTicket]               = useState(null);
  const [loading, setLoading]             = useState(true);
  const [resolving, setResolving]         = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [saving, setSaving]               = useState(false);

  useEffect(() => {
    api.get(`/tickets/${ticketId}`)
      .then(setTicket)
      .catch(() => addToast('Failed to load ticket.', 'error'))
      .finally(() => setLoading(false));
  }, [ticketId]); // eslint-disable-line

  const handleResolve = async () => {
    setSaving(true);
    try {
      const updated = await api.patch(`/tickets/${ticketId}`, {
        status:           'resolved',
        resolution_notes: resolutionNotes.trim() || null,
      });
      setTicket(updated);
      setShowResolveForm(false);
      addToast('Ticket resolved.', 'success');
      onResolved?.();
    } catch (err) {
      addToast(err.message || 'Failed to resolve ticket.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const isPending = ticket?.status === 'pending';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full w-full max-w-lg z-50
                   bg-white shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-panel-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 id="ticket-panel-title" className="text-xl font-bold text-slate-900 truncate">
              {ticket ? `Ticket #${ticket.id}` : 'Ticket'}
            </h2>
            {ticket && (
              <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border
                ${ticket.status === 'resolved'
                  ? 'bg-green-100 text-green-800 border-green-300'
                  : 'bg-amber-100 text-amber-800 border-amber-300'}`}>
                {ticket.status === 'resolved' ? 'Resolved' : 'Pending'}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : !ticket ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-slate-400 text-base">Ticket not found.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">

            {/* ── Title + Description ──────────────────────────────── */}
            <div className="px-6 py-5 border-b border-slate-400 space-y-3">
              <h3 className="text-lg font-bold text-slate-900">{ticket.title}</h3>
              <p className="text-base text-slate-700 whitespace-pre-wrap">{ticket.description}</p>
            </div>

            {/* ── Meta ─────────────────────────────────────────────── */}
            <div className="px-6 py-5 border-b border-slate-400 space-y-4">

              {ticket.amount != null && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Amount</p>
                  <p className={`text-xl font-bold tabular-nums
                    ${Number(ticket.amount) < 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {Number(ticket.amount) >= 0 ? '+' : ''}{PHP(ticket.amount)}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {ticket.related_order_id && (
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Related Order</p>
                    <Link
                      to={`/orders/${ticket.related_order_id}`}
                      onClick={onClose}
                      className="text-blue-700 font-semibold hover:underline
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                    >
                      #{ticket.related_order_id}
                    </Link>
                  </div>
                )}

                {ticket.personnel_name && (
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Related Personnel</p>
                    <p className="text-base text-slate-800 font-medium">{ticket.personnel_name}</p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm text-slate-500">
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Created By</p>
                  <p>{ticket.created_by_name ?? '—'}</p>
                  <p className="text-xs mt-0.5">
                    {new Date(ticket.created_at).toLocaleDateString('en-PH', {
                      year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            </div>

            {/* ── Resolution ───────────────────────────────────────── */}
            {ticket.status === 'resolved' ? (
              <div className="px-6 py-5 bg-green-50 border-b border-green-200">
                <p className="text-xs font-bold text-green-700 uppercase tracking-widest mb-2">Resolution</p>
                <div className="grid grid-cols-2 gap-4 text-sm text-green-800 mb-3">
                  <div>
                    <p className="font-semibold text-xs text-green-600 mb-0.5">Resolved By</p>
                    <p>{ticket.resolved_by_name ?? '—'}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-xs text-green-600 mb-0.5">Resolved On</p>
                    <p>{ticket.resolved_at
                      ? new Date(ticket.resolved_at).toLocaleDateString('en-PH', {
                          year: 'numeric', month: 'short', day: 'numeric',
                        })
                      : '—'}</p>
                  </div>
                </div>
                {ticket.resolution_notes && (
                  <p className="text-sm text-green-800 whitespace-pre-wrap">{ticket.resolution_notes}</p>
                )}
              </div>
            ) : showResolveForm ? (
              <div className="px-6 py-5 border-b border-slate-400 space-y-3">
                <p className="text-sm font-semibold text-slate-700">Resolution Notes</p>
                <textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                             focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                  placeholder="How was this resolved? (optional)"
                  autoFocus
                />
                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowResolveForm(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="warning"
                    size="sm"
                    onClick={handleResolve}
                    loading={saving}
                  >
                    Confirm Resolution
                  </Button>
                </div>
              </div>
            ) : (
              <div className="px-6 py-5">
                <Button
                  variant="warning"
                  onClick={() => setShowResolveForm(true)}
                >
                  Resolve Ticket
                </Button>
                <p className="text-xs text-slate-400 mt-2">Resolved tickets cannot be reopened or edited.</p>
              </div>
            )}

          </div>
        )}
      </div>
    </>
  );
}
