# Leyble-Hub

Ubiquitous language for Leyble-Hub's offline-capable tablet experience.

## Offline access

**Local-first read**:
A screen read that renders previously persisted tablet data immediately, then refreshes from the server in the background without an initial loading state.
_Avoid_: network-first read, loading-first read

**Unavailable-offline state**:
The explicit screen state shown when the tablet has no cached data for that screen and a network refresh cannot complete.
_Avoid_: blank screen, loading state, invented data

**Full order cache**:
The complete order collection and each order's detail data persisted on the tablet for offline browsing after synchronization, rather than only pages or records previously opened.
_Avoid_: working-set cache, list-only cache

**Online-visible order**:
An order a normal user may browse through the online interface, including historical and cancelled orders when the interface exposes them.
_Avoid_: active-order-only cache, retention-window order

**Background refresh**:
A non-blocking check for newer server data made when the app launches or resumes, after a successful local write, or when opened data has not been checked recently; it never delays cached content.
_Avoid_: blocking reload, loading-first refresh

**Sync status**:
The single header indicator that communicates connection state, queued local changes, and active background refreshes; concurrent work reads `Updating · N waiting`. A noticeable active check reads `Checking for updates…`; a check that changed data briefly reads `Updated just now`; an unchanged check returns to normal.
_Avoid_: separate read-sync and write-sync indicators

**Authoritative order state**:
The current order persisted by the server database; a tablet's copy informs the operator but never decides whether a competing command may be accepted.
_Avoid_: client authority, notification-authoritative state

**Order revision**:
An exact, opaque server-issued number that changes whenever an order changes and that a tablet supplies with a command to prove which order version it acted on.
_Avoid_: client-derived version, timestamp precondition

**Stale-write rejection**:
The server's refusal of a command whose supplied order revision is no longer current, leaving the authoritative order unchanged and returning its current state to the tablet.
_Avoid_: last-write-wins, silent overwrite

**Order change check**:
A five-second cursor-based check for server-accepted order changes, run for as long as the app is open on any screen, with the saved cursor also recovering every change missed while a tablet was disconnected. When the check cannot reach the server it backs off to progressively longer intervals rather than continuing every five seconds, and returns to the five-second cadence immediately once connectivity is confirmed again.
_Avoid_: navigation-only refresh, notification-only recovery, order-screen-only check, fixed-interval retry through a known outage

**Stale-edit warning**:
A notice that another tablet changed an order while the operator is editing it; the operator's unsaved typing remains visible until they attempt to save, and the server still decides whether that save is current.
_Avoid_: mid-edit form replacement, automatic merge

**Rejected stale save**:
The outcome when a server rejects an edit formed from an older order revision: the app shows the authoritative current order and requires the operator to deliberately re-enter any still-valid change.
_Avoid_: automatic retry, automatic reapply, silent discard

**Complete first setup**:
The new-tablet state reached only after the complete historical order cache has downloaded; normal app access remains unavailable until then.
_Avoid_: reference-data-only unlock, partial-history unlock

**First-setup progress**:
The phase-based full-screen status shown while a new tablet downloads its required history, including a clear waiting-for-connection state if that download is interrupted; it resumes automatically from its saved position when connectivity returns and retains a Retry action.
_Avoid_: generic spinner, false percentage, restart-from-zero setup

**Shared tablet cache**:
Store-wide offline data held by a tablet for every currently authorized account; it is an explicit temporary policy and must be redesigned before any role receives restricted data visibility.
_Avoid_: assumed role isolation, logout-wipe cache

**Storage-safe setup**:
A first setup that cannot hold the complete required order history stops with a clear storage explanation instead of silently trimming history or opening a partial cache.
_Avoid_: automatic history trimming, partial-cache unlock

**Current cache protection**:
The store-wide offline cache has no added device-lock or app-level encryption requirement in the current scope; role-specific protection remains a future design concern.
_Avoid_: assumed encrypted-cache guarantee

**Permanent cache store**:
The current native key-value store remains the chosen store for complete order history without a required capacity gate or SQLite migration.
_Avoid_: assumed mandatory SQLite migration

**Orders-first update rollout**:
The five-second cross-tablet update and stale-write protection launches for orders before inventory or other app areas, where stale state can affect delivery and stock.
_Avoid_: whole-app-first rollout, coupled inventory rollout

**Live order view**:
A non-editing order screen that adopts an accepted change from another tablet immediately without a spinner, with the shared header sync status acknowledging the update.
_Avoid_: manual reload banner, blocking replacement confirmation

**Live filtered order list**:
An order list that immediately removes a changed row when it no longer matches the active filter and briefly states the status it moved to.
_Avoid_: stale filtered row, manual refresh dependency

**Stale bulk selection**:
A bulk selection containing an order changed elsewhere remains visibly selected but blocks confirmation until the operator reviews it and deliberately removes it; the eventual action names only the remaining orders.
_Avoid_: silent unselection, implicit partial bulk action, whole-selection cancellation

**Independent bulk commit**:
Each order within a confirmed bulk action is evaluated and written on its own rather than as one all-or-nothing transaction, so an order that goes stale in the final moment before submission fails alone while the rest of the already-reviewed batch still commits.
_Avoid_: all-or-nothing bulk transaction, whole-batch cancellation on one late conflict

**Bulk action outcome**:
The plain-language result shown once a bulk order action finishes, naming how many orders were updated and identifying any order skipped because it changed at the last moment, with a way to open that order and see its current state.
_Avoid_: silent partial completion, a blocking list of every skipped order
