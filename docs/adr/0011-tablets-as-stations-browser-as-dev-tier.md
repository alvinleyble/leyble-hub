# Only the Android App is a Station; the Browser is a Development Tier

**Status:** Settled (2026-08-25)  
**Origin:** Captain decision G2 (2026-08-25)  
**See also:** [ADR 0003: Device-Issued Receipt Numbers](0003-device-issued-receipt-numbers.md), [ADR 0007: Native Storage for Device State](0007-native-storage-for-device-state.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

## Context

In production, Leyble Hub runs exclusively as an Android APK (via Capacitor) installed on physical tablets in the store in Antipolo. There are no desktop computers in the store, and the cloud backend on Render is strictly an API-only service that does not serve a web client.

Under the initial V2.5 offline architecture, non-native platforms defaulted to an in-memory `Map` storage backend (`memoryBackend` in [`nativeStore.js`](../../../client/src/offline/nativeStore.js)) to satisfy [ADR 0007](0007-native-storage-for-device-state.md) (which strictly forbade browser `localStorage` on Android). However, this created a severe issue during local browser development:

Every desktop browser page reload (or Vite hot-reload) wiped the in-memory map and generated a fresh `crypto.randomUUID()` device key. When `startOfflineCore()` ran, `ensureStationRegistered()` called `POST /api/v1/stations/register`, which treated each reload as an unrecognised device and allocated a brand new, permanently unreclaimable integer from the PostgreSQL `stations_id_seq` sequence. An afternoon of browser development would consume dozens of station numbers (e.g. Station 7, 8, 9, 10...) on the connected development database.

## Decision

We are formalizing the role of physical Android devices as the sole production stations, while establishing a dedicated persistent storage tier for browser development:

1. **Production Stations are Tablets Only:** Only physical Android tablet installations (`@capacitor/preferences`) represent genuine production stations that issue legal customer receipt numbers.
2. **Persistent Dev Storage Backend:** In non-native environments (browser `npm run dev`), [`nativeStore.js`](../../../client/src/offline/nativeStore.js) uses browser `localStorage` instead of an ephemeral in-memory map. This allows the local development browser to register **once**, persist its station ID and receipt sequence across page reloads, and act as a genuine test surface for outbox queuing, reload survival, and background drain.
3. **Explicit Dev Station Labels:** When registering a station in non-native mode, the client passes `label: "dev — <hostname>"` to `POST /api/v1/stations/register`. Dev-registered stations are clearly identifiable when inspecting the `stations` table.
4. **Development vs. Device Testing Separation:**
   - **Browser Tier:** Used for rapid UI layout, category filtering, tile interactions, draft debouncing, and outbox drain logic. Hot reload is supported via Vite.
   - **Android Emulator / Physical Device:** Reserved for verifying hardware-specific behavior: native storage persistence surviving app termination / OS memory pressure, Android "clear data" resilience, Bluetooth/WiFi thermal printing, and screen orientation locks.

## Considered Options

- **Option A: Persistent Dev Storage Backend with Labeled Registration (Chosen)** — Gives the browser persistent storage across reloads so station registration is executed once per developer machine. Prevents station ID sequence exhaustion while providing a realistic test environment.
- **Option B: Ephemeral In-Memory Map (Rejected)** — Retaining the in-memory map. Rejected because it exhausts database station sequences on every browser refresh and makes local testing of outbox reload survival impossible.
- **Option C: Mocking Station Registration in Dev (Rejected)** — Bypassing `POST /api/v1/stations/register` and hardcoding Station 99 in dev. Rejected because it creates a divergent code path that leaves station registration logic untested during daily development.

## Consequences

- Station sequences on development and staging databases remain compact and uncontaminated.
- Developers can realistically simulate network outages in desktop Chrome, reload the tab, and observe queued outbox receipts surviving without native Android tooling.
