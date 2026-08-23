import React, { useState } from 'react';
import { V25_OFFLINE_CORE } from '../../config/features';
import { useOfflineStatus } from '../../offline/status';
import NeedsAttentionModal from '../pos/NeedsAttentionModal';

// D7 — Outbox status marker: shown only when there is something to say.
//
// Normal / online with 0 waiting  ->  Nothing at all (null)
// Offline with N waiting          ->  "Offline · N waiting"
// Offline with 0 waiting          ->  "Offline"
// Online with N waiting           ->  "N waiting"
//
// If receipts need attention (D8), clicking the marker opens the attention modal.
export default function OfflineMarker() {
  const [attentionModalOpen, setAttentionModalOpen] = useState(false);
  const { isOnline, waitingCount, needsAttentionCount } = useOfflineStatus();

  if (!V25_OFFLINE_CORE) return null;

  // When online, empty outbox, and no attention items: zero wallpaper.
  if (isOnline && waitingCount === 0 && needsAttentionCount === 0) {
    return null;
  }

  let label = '';
  if (!isOnline) {
    if (waitingCount > 0) {
      label = `Offline · ${waitingCount} waiting`;
    } else {
      label = 'Offline';
    }
  } else {
    // Online with waiting records
    label = `${waitingCount} waiting`;
  }

  const hasAttention = needsAttentionCount > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (hasAttention) setAttentionModalOpen(true);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold tracking-tight select-none
                   transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                   ${hasAttention
                     ? 'border border-red-500/50 bg-red-950/40 text-red-300 hover:bg-red-900/50 cursor-pointer animate-pulse'
                     : !isOnline
                       ? 'border border-amber-500/40 bg-amber-500/15 text-amber-300 cursor-default'
                       : 'border border-sky-500/40 bg-sky-500/15 text-sky-300 cursor-default'}`}
        role="status"
        aria-live="polite"
        title={hasAttention ? `${needsAttentionCount} receipt(s) need attention — click to review` : label}
      >
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${
            hasAttention ? 'bg-red-400' : !isOnline ? 'bg-amber-400' : 'bg-sky-400'
          }`}
          aria-hidden="true"
        />
        <span>{label}</span>
        {hasAttention && (
          <span className="ml-1 rounded bg-red-500/30 px-1.5 py-0.2 text-xs font-black text-red-200">
            {needsAttentionCount} needs attention
          </span>
        )}
      </button>

      {attentionModalOpen && (
        <NeedsAttentionModal onClose={() => setAttentionModalOpen(false)} />
      )}
    </>
  );
}
