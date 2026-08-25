# One Build-Time Release Switch for the Offline Core

**Status:** Superseded (2026-08-25 by [ADR 0013: The Offline Core Ships Unswitched; No Flag-Based Rollback](0013-unswitched-offline-core-no-flag-rollback.md))  
**Origin:** Captain decision D18, refining D12 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [ADR 0004](0004-local-first-pos.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

*(Preserved for historical context: the build-time release switch `V25_OFFLINE_CORE` was used to land the offline core across four PRs while dark. In V3.0, the switch was retired and the offline core was made permanently active).*

## Context

D12 established that the offline core is one indivisible **release**: an offline POS without safe receipt numbers, or one that loses parked orders, is worse than today's app, so half of it is not half as useful — it is unusable.

But one release does not have to be one pull request. The core is a large body of work touching the POS save path, storage, sync, the server's write path and several screens, and reviewing it as a single diff would be reviewing it badly.

The two requirements pull in different directions: the work has to land in pieces small enough to review, and none of those pieces may reach the owners before all of them do.

## Decision

The core ships as four separately reviewable pull requests, each dark on arrival, behind **one switch that every piece reuses**.

1. **The Switch:** `V25_OFFLINE_CORE`, exported from `client/src/config/features.js`, read once at module load from `import.meta.env.VITE_V25_OFFLINE_CORE`. Off unless the value is exactly `on`.
2. **Build-Time, Not Runtime:** The release build sets `VITE_V25_OFFLINE_CORE=on`; every other build leaves it unset. The value cannot change while the app is running.
3. **Off Must Be Indistinguishable From Today:** With the switch off, no piece of the core may change what the app does. This is the property each piece is reviewed against.
4. **The Database is Not Behind the Switch:** `render.yaml` runs `node server/db/migrate.js` on every deploy to the single production environment, so a migration reaches live data whether or not the feature is on. Every migration in this release is therefore additive, correct standing alone with no client yet issuing receipt numbers, and correct with the previously deployed server still running during the build window.
5. **The Server is Dark by Data, Not by Flag:** The API's new behaviour is reachable only when a request actually carries a `receipt_number` or a device `created_at`, which only a switched-on client sends. There is deliberately no server-side flag to keep in step with the client's — two switches that must agree are a way to have them disagree.
6. **A Separate Build-Side Offline Switch:** `VITE_V25_SIMULATE_OFFLINE` (and `window.__leyble.simulateOffline()` in dev builds) makes the outbox refuse to drain, so the local-first path can be exercised without unplugging anything. It is a verification tool with no UI. D10 is explicit that the owners rehearse nothing, so this is never a surface they are pointed at.

## Considered Options

- **Option A: One Build-Time Flag Reused by Every Piece (Chosen)** — The switch has to be readable when the device is blind, so it cannot depend on the server. A release is a new APK either way (there is no web client, so every UI change means reinstalling), which makes a build-time flag free. And a switch that could flip mid-session could make a half-drained outbox appear or vanish under the owners' hands, which is the one thing D7 exists to prevent.
- **Option B: A Server-Delivered Feature Flag (Rejected)** — Fetched at start-up or per session. Rejected because a device that is offline cannot read it, which makes the offline feature's own switch depend on the network; and because it introduces a mid-session flip.
- **Option C: An In-App Setting (Rejected)** — A toggle the owners could turn on. Rejected on the same mid-session grounds, and because D10 rules out asking the owners to participate in the rollout at all.
- **Option D: A Long-Lived Feature Branch, No Flag (Rejected)** — Keep the four pieces on a branch and merge once. Rejected because the pieces would then be reviewed as one diff after all, and because a branch held open across four pieces of work drifts from `dev`.
- **Option E: One Flag Per Piece (Rejected)** — Finer-grained control. Rejected because the release is switched on as a unit by definition (D12), so per-piece flags would only create combinations that were never designed to run and never tested together.

## Consequences

- Each piece can merge as soon as it is reviewed, with the release date decoupled from the merge dates.
- Reviewing "does this change anything with the switch off?" is a concrete, checkable question for every piece.
- Turning the release on is a build-environment change and a new APK, not a code change — so the switch-on is a deployment step, not another pull request.
- The migrations land ahead of the feature, which is why each of them must be safe standing entirely alone. That is a constraint on the schema work, not a side effect of it.
