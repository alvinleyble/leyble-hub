import { nativeStore } from './nativeStore.js';
import { LAST_SYNCED_KEY } from './keys.js';

// "Last synced" for the Settings page: the last time this device and the server
// actually exchanged sync data. Written at the existing success points only — a drain
// pass that sent something (outbox.js), a sync run where any step got an answer and an
// order poll that returned (sync.js). Recording it never changes what those do: every
// write here swallows its own failure, so a storage hiccup cannot fail a drain or a sync.

const listeners = new Set();

export async function recordLastSynced(at = Date.now()) {
  try {
    await nativeStore.setJson(LAST_SYNCED_KEY, at);
  } catch {
    return;
  }
  for (const listener of listeners) {
    try { listener(at); } catch {}
  }
}

// Epoch ms, or null when this device has never synced (or has not since this build).
export async function getLastSynced() {
  try {
    const at = await nativeStore.getJson(LAST_SYNCED_KEY);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

export function subscribeLastSynced(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
