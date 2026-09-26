import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import { useOfflineStatus } from '../../offline/status.js';
import { useSyncActivity } from '../../offline/sync.js';
import NeedsAttentionModal from '../pos/NeedsAttentionModal.jsx';

// D7 — the standing connection marker, now a text-less light beside the menu button.
//
// It used to be a pill that spelled its state out; the top tab bar has no room for
// words, so the colour carries the state at a glance and a tap spells it out:
//   green  — online, everything saved
//   blue   — checking for updates, or still sending what is waiting
//   orange — offline (receipts keep saving on the tablet)
//   red    — something needs attention; tapping opens the attention list, as the
//            pill did, and it pulses faster than the other colours
// Every wording the pill could show is still reachable through that tap (and is the
// light's accessible name), so no state the old marker distinguished is lost.
//
// When V25_OFFLINE_CORE is off, renders null.

const TONES = {
  green:  { dot: 'bg-emerald-400 ring-emerald-400/30', pulse: 'motion-safe:animate-status-pulse' },
  blue:   { dot: 'bg-sky-400 ring-sky-400/30',         pulse: 'motion-safe:animate-status-pulse' },
  orange: { dot: 'bg-orange-400 ring-orange-400/30',   pulse: 'motion-safe:animate-status-pulse' },
  red:    { dot: 'bg-red-500 ring-red-500/40',         pulse: 'motion-safe:animate-status-pulse-fast' },
};

/**
 * Maps the offline core's state onto one of the light's four colours and the words the
 * tap shows. Precedence is the old marker's: attention, then offline, then checking,
 * then waiting. "Updated just now" stays green only once nothing is left to send.
 */
export function lightStatus({ isOnline, waitingCount = 0, needsAttentionCount = 0, checking = false, recentlyUpdated = false }) {
  const waiting = waitingCount > 0 ? ` · ${waitingCount} waiting` : '';
  if (needsAttentionCount > 0) {
    return { tone: 'red', label: `${needsAttentionCount} ${needsAttentionCount === 1 ? 'needs' : 'need'} attention${waiting}` };
  }
  if (!isOnline) return { tone: 'orange', label: `Offline${waiting}` };
  if (checking) {
    return { tone: 'blue', label: waitingCount > 0 ? `Updating${waiting}` : 'Checking for updates…' };
  }
  if (recentlyUpdated) return { tone: waitingCount > 0 ? 'blue' : 'green', label: `Updated just now${waiting}` };
  if (waitingCount > 0) return { tone: 'blue', label: `Sending${waiting}` };
  return { tone: 'green', label: 'Online · all saved' };
}

// Gated before any hook runs, so a build with the offline core off does not poll the
// outbox for a light nobody sees.
export default function StatusLight() {
  return V25_OFFLINE_CORE ? <StatusLightButton /> : null;
}

// Exported for tests, which cannot switch the build flag on (see CLAUDE.md).
export function StatusLightButton() {
  const [attentionModalOpen, setAttentionModalOpen] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const wrapRef = useRef(null);
  const { pathname } = useLocation();
  const { isOnline, waitingCount, needsAttentionCount } = useOfflineStatus();
  const { checking, recentlyUpdated } = useSyncActivity();
  const { tone, label } = lightStatus({ isOnline, waitingCount, needsAttentionCount, checking, recentlyUpdated });
  const hasAttention = tone === 'red';

  // Moving to another page puts the popup away, like any tap outside it.
  useEffect(() => { setPopupOpen(false); }, [pathname]);

  useEffect(() => {
    if (!popupOpen) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setPopupOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPopupOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [popupOpen]);

  const { dot, pulse } = TONES[tone];

  return (
    <div ref={wrapRef} className="relative flex h-full items-center">
      <button
        type="button"
        onClick={() => {
          if (hasAttention) {
            setPopupOpen(false);
            setAttentionModalOpen(true);
          } else {
            setPopupOpen((open) => !open);
          }
        }}
        aria-label={hasAttention ? `Connection status: ${label}. Tap to review.` : `Connection status: ${label}`}
        aria-expanded={hasAttention ? undefined : popupOpen}
        title={label}
        data-testid="status-light"
        data-tone={tone}
        className="flex h-12 w-10 items-center justify-center rounded-lg hover:bg-slate-800
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className={`block h-3.5 w-3.5 rounded-full ring-4 ${dot} ${pulse}`} aria-hidden="true" />
      </button>
      {/* The light itself has no words, so its changes are announced from here. */}
      <span className="sr-only" role="status" aria-live="polite">{label}</span>

      {popupOpen && !hasAttention && (
        <div
          className="absolute right-0 top-full z-50 mt-1 flex items-center gap-2 whitespace-nowrap rounded-lg
                     border border-slate-200 bg-white px-3 py-2 text-base font-semibold text-slate-900 shadow-lg"
          data-testid="status-light-popup"
        >
          <span className={`block h-2.5 w-2.5 shrink-0 rounded-full ${dot.split(' ')[0]}`} aria-hidden="true" />
          {label}
        </div>
      )}

      {attentionModalOpen && (
        <NeedsAttentionModal onClose={() => setAttentionModalOpen(false)} />
      )}
    </div>
  );
}
