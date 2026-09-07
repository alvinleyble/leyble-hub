import React, { useEffect, useState, useCallback } from 'react';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import {
  listConflicts, subscribeConflicts, STOCK_FIELD, CAUSE_UNEXPLAINED_MOVEMENT,
} from '../../offline/reconcile.js';
import { resolveConflict, keepServerValue } from '../../offline/productMutations.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

// ADR 0015 §6 — "the discrepancy must be surfaced in a prominent reconciliation
// view/modal where an operator reviews both inputs and confirms the true physical
// inventory count."
//
// This is deliberately NOT the needs-attention modal. That one is for records the
// SERVER REFUSED: something is wrong, and the fix is to re-point and resend. Here
// nothing is wrong — two people counted the same shelf and got different answers, and
// both numbers are honest. So the question is never "which record is broken" but
// "what is actually on the shelf", and the third button exists for exactly the case
// where the honest answer is neither of the two numbers on screen.
//
// No option quietly wins by default. Closing the modal leaves the question open;
// nothing is sent until somebody says which value is true.
//
// Ordinary business movement — a sale, a delivery — does NOT arrive here: the guard
// re-derives the queued count as a delta instead of asking. The one exception is a
// movement it could not account for (`CAUSE_UNEXPLAINED_MOVEMENT`), which lands here
// with different words, because claiming "another tablet counted this" when nobody did
// is exactly how a modal teaches people to stop reading it.

function formatValue(conflict, value) {
  return conflict.field === STOCK_FIELD
    ? `${Number(value)}${conflict.unit ? ` ${conflict.unit}` : ''}`
    : PHP(value);
}

function formatWhen(value) {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ConflictCard({ conflict, onResolved }) {
  const { addToast } = useToast();
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isStock = conflict.field === STOCK_FIELD;
  const noun = isStock ? 'count' : 'price';
  const unexplained = conflict.cause === CAUSE_UNEXPLAINED_MOVEMENT;

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onResolved();
    } catch (err) {
      setError(err.message || 'Could not save that. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = (value) => act(async () => {
    await resolveConflict(conflict.id, { value });
    addToast(
      `${conflict.product_name}: ${noun} confirmed as ${formatValue(conflict, value)}.`,
      'success'
    );
  });

  const keepTheirs = () => act(async () => {
    await keepServerValue(conflict.id);
    addToast(
      unexplained
        ? `${conflict.product_name}: kept the server's ${noun} (${formatValue(conflict, conflict.theirs)}).`
        : `${conflict.product_name}: kept the other tablet's ${noun} (${formatValue(conflict, conflict.theirs)}).`,
      'success'
    );
  });

  return (
    <li className="rounded-xl border border-amber-300 bg-white overflow-hidden">
      <div className="px-5 py-4 bg-amber-50 border-b border-amber-200">
        <p className="text-lg font-bold text-slate-900">{conflict.product_name}</p>
        <p className="text-sm text-amber-900 mt-0.5">
          {unexplained
            ? `This ${noun} changed on the server while this tablet was offline, and there is no record here of why.`
            : isStock
              ? 'Two tablets corrected this stock count while they were offline.'
              : 'Two tablets changed this price while they were offline.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 px-5 py-4">
        <div className="rounded-lg border border-slate-300 p-4">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
            This tablet
          </p>
          <p className="text-3xl font-bold tabular-nums text-slate-900">
            {formatValue(conflict, conflict.mine)}
          </p>
          {conflict.reason && (
            <p className="text-sm text-slate-500 mt-1 italic">"{conflict.reason}"</p>
          )}
          {formatWhen(conflict.queued_at) && (
            <p className="text-xs text-slate-400 mt-1">Entered {formatWhen(conflict.queued_at)}</p>
          )}
          <Button
            className="mt-3 w-full"
            onClick={() => confirm(conflict.mine)}
            disabled={busy}
          >
            This one is right
          </Button>
        </div>

        <div className="rounded-lg border border-slate-300 p-4">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
            {unexplained ? 'Now on the server' : 'Another tablet (now on the server)'}
          </p>
          <p className="text-3xl font-bold tabular-nums text-slate-900">
            {formatValue(conflict, conflict.theirs)}
          </p>
          {conflict.their_reason && (
            <p className="text-sm text-slate-500 mt-1 italic">"{conflict.their_reason}"</p>
          )}
          {formatWhen(conflict.their_at) && (
            <p className="text-xs text-slate-400 mt-1">Entered {formatWhen(conflict.their_at)}</p>
          )}
          <Button
            className="mt-3 w-full"
            variant="secondary"
            onClick={keepTheirs}
            disabled={busy}
          >
            This one is right
          </Button>
        </div>
      </div>

      <div className="px-5 pb-5">
        <FormField
          label={isStock ? 'Or enter the count you just made' : 'Or enter the correct price'}
          hint={isStock
            ? 'Use this when neither number matches what is actually on the shelf.'
            : 'Use this when neither price is the agreed one.'}
        >
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step={isStock ? '0.5' : '0.01'}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className={INPUT}
              aria-label={isStock ? 'Confirmed physical count' : 'Confirmed price'}
            />
            <Button
              variant="secondary"
              onClick={() => confirm(custom)}
              disabled={busy || custom === ''}
            >
              Confirm
            </Button>
          </div>
        </FormField>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>
    </li>
  );
}

export default function StockReconcileModal({ onClose, onResolvedAll }) {
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await listConflicts().catch(() => []);
    setConflicts(list);
    setLoading(false);
    if (list.length === 0) onResolvedAll?.();
  }, [onResolvedAll]);

  useEffect(() => {
    refresh();
    return subscribeConflicts(() => { refresh(); });
  }, [refresh]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/50 overflow-y-auto"
      role="dialog" aria-modal="true" aria-labelledby="stock-reconcile-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl my-8 flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <div className="min-w-0">
            <h2 id="stock-reconcile-title" className="text-xl font-bold text-slate-900">
              Confirm stock &amp; price changes
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Nothing is saved until you pick the right value.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size="lg" /></div>
        ) : conflicts.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-base text-slate-500">Nothing left to confirm.</p>
            <Button variant="secondary" className="mt-4" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <ul className="px-6 py-5 space-y-5">
            {conflicts.map((c) => (
              <ConflictCard key={c.id} conflict={c} onResolved={refresh} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
