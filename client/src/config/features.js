// The V2.5 offline core's off switch (D18).
//
// D12 requires the offline core to reach the owners as ONE release; D18 refines that
// to four separately reviewable pieces that all land dark and are switched on
// together. This module is that switch, and the later pieces reuse it rather than
// inventing flags of their own.
//
// How it works
// ------------
// Build-time, not runtime. The value is read from the Vite environment once at module
// load and never changes while the app is running:
//
//   VITE_V25_OFFLINE_CORE=on npm run build     # release build, offline core live
//   npm run build                              # every other build, offline core dark
//
// Build-time was chosen over a server-delivered flag or an in-app toggle for two
// reasons. The switch has to be readable when the device is blind, so it cannot
// depend on the server. And a switch that can flip mid-session could make a
// half-drained outbox appear or vanish under the owners' hands — the one thing D7
// exists to prevent. A release is a new APK either way (see CLAUDE.md: every UI
// change requires reinstalling the APK), so a build-time flag costs nothing.
//
// Off is the default and off must be indistinguishable from today: with the switch
// off, no piece of the offline core may change what the app does.

function readFlag(name) {
  // import.meta.env is replaced at build time by Vite; under `node --test` the test
  // loader defines it as {}. Either way an unset flag reads as off.
  const raw = (import.meta.env && import.meta.env[name]) ?? '';
  return String(raw).toLowerCase() === 'on';
}

// The one switch for the whole V2.5 offline core: local-first save, device-issued
// receipt numbers, the outbox, the offline marker, the attention list.
export const V25_OFFLINE_CORE = readFlag('VITE_V25_OFFLINE_CORE');

// D10 — the owners rehearse nothing. This is the BUILD-SIDE offline switch, for
// whoever verifies the release: it makes the outbox refuse to drain so the local-first
// path can be exercised without unplugging anything. It is never a surface the owners
// are pointed at, so it has no UI and is only reachable from a dev build's console:
//
//   VITE_V25_SIMULATE_OFFLINE=on npm run dev
//   window.__leyble.simulateOffline(true)     // dev builds only
let simulatedOffline = readFlag('VITE_V25_SIMULATE_OFFLINE');

export function isSimulatedOffline() {
  return simulatedOffline;
}

export function setSimulatedOffline(value) {
  simulatedOffline = !!value;
  return simulatedOffline;
}

if (typeof window !== 'undefined' && import.meta.env && import.meta.env.DEV) {
  window.__leyble = { ...(window.__leyble || {}), simulateOffline: setSimulatedOffline };
}
