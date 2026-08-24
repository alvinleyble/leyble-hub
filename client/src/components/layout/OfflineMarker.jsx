import React, { useState } from 'react';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import { useOfflineStatus } from '../../offline/status.js';
import NeedsAttentionModal from '../pos/NeedsAttentionModal.jsx';

// D7 — Standing connection marker (revised 2026-08-24).
//
// Always visible once V25_OFFLINE_CORE is on.
// - Online, 0 waiting: calm "Online" indicator (no alarm, no red).
// - Online, records draining: "N waiting".
// - Offline, 0 waiting: "Offline".
// - Offline, N waiting: "Offline · N waiting".
// - Needs attention: Red attention badge, clickable to open NeedsAttentionModal.
//
// When V25_OFFLINE_CORE is off, renders null.
export default function OfflineMarker() {
  const [attentionModalOpen, setAttentionModalOpen] = useState(false);
  const { isOnline, waitingCount, needsAttentionCount } = useOfflineStatus();

  if (!V25_OFFLINE_CORE) return null;

  const hasAttention = needsAttentionCount > 0;

  let label = 'Online';
  let dotClass = 'bg-emerald-400';
  let containerClass = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 cursor-default';

  if (hasAttention) {
    label = waitingCount > 0 ? `${waitingCount} waiting` : 'Needs attention';
    dotClass = 'bg-red-400';
    containerClass = 'border-red-500/50 bg-red-950/40 text-red-300 hover:bg-red-900/50 cursor-pointer animate-pulse';
  } else if (!isOnline) {
    label = waitingCount > 0 ? `Offline · ${waitingCount} waiting` : 'Offline';
    dotClass = 'bg-amber-400';
    containerClass = 'border-amber-500/40 bg-amber-500/15 text-amber-300 cursor-default';
  } else if (waitingCount > 0) {
    label = `${waitingCount} waiting`;
    dotClass = 'bg-sky-400';
    containerClass = 'border-sky-500/40 bg-sky-500/15 text-sky-300 cursor-default';
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (hasAttention) setAttentionModalOpen(true);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold tracking-tight select-none
                   transition-colors duration-150 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                   ${containerClass}`}
        role="status"
        aria-live="polite"
        title={hasAttention ? `${needsAttentionCount} receipt(s) need attention — click to review` : label}
      >
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`}
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
