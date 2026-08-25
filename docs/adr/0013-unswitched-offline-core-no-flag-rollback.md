# The Offline Core Ships Unswitched; There is No Flag-Based Rollback

**Status:** Settled (2026-08-25)  
**Origin:** Captain decision G11 (2026-08-25)  
**Supersedes:** [ADR 0008: One Build-Time Release Switch for the Offline Core](0008-release-switch-for-the-offline-core.md)  
**See also:** [ADR 0004: Local-First POS](0004-local-first-pos.md), [ADR 0007: Native Storage for Device State](0007-native-storage-for-device-state.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

## Context

[ADR 0008](0008-release-switch-for-the-offline-core.md) defined a build-time release switch (`VITE_V25_OFFLINE_CORE`) that allowed the offline local-first engine to be merged across four separate pull requests without altering the production app until all components were ready.

With the arrival of V3.0, the offline core is fully built, integrated with V1 screens, and ready for deployment. Continuing to maintain the `V25_OFFLINE_CORE` feature flag as a hypothetical "rollback switch" introduces extreme operational hazard:

The flag is referenced across 17 distinct codebase files. If an administrator were to toggle the flag off in a build deployed to a tablet that currently holds unsynced receipts in its native outbox:
1. `orderRef()` would cease returning device-issued receipt numbers.
2. `OfflineMarker.jsx` would render `null`, hiding the outbox count.
3. The background sync loop would stop running.
4. The unsynced sales would become completely invisible on screen while remaining trapped in the tablet's native storage.

This would directly cause the silent loss of customer sales records that the offline architecture was explicitly created to prevent.

## Decision

We are removing the release switch and shipping the offline core permanently active:

1. **Retiring the Release Flag:** `VITE_V25_OFFLINE_CORE` and its export `V25_OFFLINE_CORE` in [`client/src/config/features.js`](../../../client/src/config/features.js) are removed. All 17 call sites are simplified to execute the offline/local-first code path permanently.
2. **Dedicated Test Toggle Retained:** The verification switch `VITE_V25_SIMULATE_OFFLINE` (and `window.__leyble.simulateOffline()` in dev builds) is retained strictly as a developer and QA tool to force the outbox to pause draining without physical network disconnection.
3. **Honest Rollback Limitation:** There is no configuration flag or runtime toggle to disable the offline core. If an emergency rollback is required in production, the only valid mechanism is building and sideloading a prior APK version (which will still strand any records remaining in the local outbox).

## Considered Options

- **Option A: Remove Release Switch and Permanently Activate Core (Chosen)** — Removes dead conditional branches across 17 files and eliminates the risk of stranding outbox receipts behind a disabled flag.
- **Option B: Retain Build-Time Flag as Rollback Mechanism (Rejected)** — Retaining `VITE_V25_OFFLINE_CORE=off` as an emergency lever. Rejected because turning it off renders unsynced outbox records invisible while still stored locally, creating silent data corruption.
- **Option C: Runtime Feature Flag from Server (Rejected)** — Fetching feature flags from the API. Rejected because offline devices cannot fetch remote flags, making an offline system dependent on network connectivity to know whether to function offline.

## Consequences

- ADR 0008 is formally superseded and retired.
- Code complexity is reduced across the client codebase by removing 17 feature flag conditionals.
- Operational documentation clearly reflects that the local-first engine is the permanent, standard execution path.
