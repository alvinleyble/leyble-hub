import React, { useCallback, useEffect, useRef, useState } from 'react';
import NavIcon from './NavIcon';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import { subscribeOutbox } from '../../offline/outbox.js';
import {
  loadSyncDetails, formatWhen,
  STATE_NEXT, STATE_WAITING, STATE_BLOCKED, STATE_ATTENTION,
} from '../../offline/syncDetails.js';
import { toneClass } from '../../utils/statusBadges.js';

// Sync details — what this tablet still has to send, oldest first, with each record's
// tries and last error. Opened from the status light. Read-only on purpose: it shows
// why a tablet is stuck without adding a way to change the queue; the Needs attention
// list keeps its own actions.

const STATE_BADGES = {
  [STATE_NEXT]:      { label: 'Next to send', tone: 'blue' },
  [STATE_WAITING]:   { label: 'Waiting', tone: 'slate' },
  [STATE_BLOCKED]:   { label: 'Waiting for another item', tone: 'slate' },
  [STATE_ATTENTION]: { label: 'Needs attention', tone: 'amber' },
};

const PILL = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap';

function StateBadge({ state }) {
  const b = STATE_BADGES[state] || STATE_BADGES[STATE_WAITING];
  return <span className={`${PILL} ${toneClass(b.tone)}`} data-testid="sync-details-state">{b.label}</span>;
}

function triesText(attempts) {
  if (!attempts) return 'Not tried yet';
  return `${attempts} ${attempts === 1 ? 'time' : 'times'}`;
}

function RecordCard({ row, position }) {
  const isNext = row.state === STATE_NEXT;
  return (
    <li
      data-testid={`sync-details-record-${row.id}`}
      data-state={row.state}
      className={`rounded-xl border bg-white p-4 ${isNext ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-300'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-600">{position}.</span>
        <StateBadge state={row.state} />
      </div>
      <p className="mt-2 text-base font-bold text-slate-900 break-words" data-testid="sync-details-title">{row.title}</p>
      {row.detail && <p className="mt-0.5 text-sm text-slate-700 break-words">{row.detail}</p>}

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-slate-600">Saved</dt>
          <dd className="text-slate-900">{formatWhen(row.createdAt) || 'Unknown'}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Tries</dt>
          <dd className="text-slate-900" data-testid="sync-details-attempts">{triesText(row.attempts)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Last try</dt>
          <dd className="text-slate-900" data-testid="sync-details-last-try">
            {formatWhen(row.lastAttemptAt) || (row.attempts ? 'Not recorded' : '—')}
          </dd>
        </div>
      </dl>

      {row.error && (
        <div
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-base font-semibold text-amber-900"
          data-testid="sync-details-error"
        >
          {row.error}
        </div>
      )}

      <details className="mt-3 text-sm text-slate-700">
        <summary
          className="flex min-h-[48px] cursor-pointer items-center rounded-lg font-semibold text-blue-700
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Technical details
        </summary>
        <dl className="mt-1 space-y-1 break-words" data-testid="sync-details-technical">
          {row.rawError && (
            <div>
              <dt className="inline font-semibold">Message: </dt>
              <dd className="inline font-mono" data-testid="sync-details-raw-error">{row.rawError}</dd>
            </div>
          )}
          {row.errorStatus != null && (
            <div><dt className="inline font-semibold">Server answer: </dt><dd className="inline font-mono">{row.errorStatus}</dd></div>
          )}
          <div><dt className="inline font-semibold">Request: </dt><dd className="inline font-mono">{row.request}</dd></div>
          <div><dt className="inline font-semibold">Item number: </dt><dd className="inline font-mono">{row.id}</dd></div>
          {row.savedBy && (
            <div><dt className="inline font-semibold">Saved by: </dt><dd className="inline">{row.savedBy}</dd></div>
          )}
        </dl>
      </details>
    </li>
  );
}

export default function SyncDetailsModal({ onClose, load = loadSyncDetails }) {
  const [data, setData] = useState(null);
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const liveRef = useRef(true);

  const refresh = useCallback(() => {
    load()
      .then((d) => { if (liveRef.current) setData(d); })
      .catch(() => { if (liveRef.current) setData({ rows: [], waitingCount: 0, attentionCount: 0 }); });
  }, [load]);

  useEffect(() => {
    liveRef.current = true;
    refresh();
    // Every enqueue, drain pass and re-point notifies, so the list follows the queue
    // while it is open.
    const unsubscribe = subscribeOutbox(() => { refresh(); });
    return () => { liveRef.current = false; unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rows = data?.rows || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-details-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      data-testid="sync-details-modal"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-4 flex w-full max-w-2xl min-w-0 flex-col rounded-xl bg-white shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-300 px-4 py-3 sm:px-6">
          <h2 id="sync-details-title" className="text-xl font-bold text-slate-900">Sync details</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-12 w-12 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <NavIcon name="close" className="h-6 w-6" />
          </button>
        </div>

        <div className="px-4 py-4 sm:px-6">
          {!data ? (
            <div className="flex h-32 items-center justify-center"><Spinner size="md" /></div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center" data-testid="sync-details-empty">
              <p className="text-base font-semibold text-slate-900">Nothing waiting to sync.</p>
              <p className="mt-1 text-sm text-slate-600">Everything saved on this tablet has reached the server.</p>
            </div>
          ) : (
            <>
              <p className="text-base font-semibold text-slate-900" data-testid="sync-details-summary">
                {data.waitingCount} waiting to send
                {data.attentionCount > 0 && ` · ${data.attentionCount} ${data.attentionCount === 1 ? 'needs' : 'need'} attention`}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Oldest first. The tablet sends them in this order, so if the first one keeps
                failing, the ones behind it wait.
              </p>
              <ol className="mt-4 space-y-3" data-testid="sync-details-list">
                {rows.map((row, i) => <RecordCard key={row.id} row={row} position={i + 1} />)}
              </ol>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-slate-300 px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
