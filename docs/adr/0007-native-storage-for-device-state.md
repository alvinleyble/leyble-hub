# Device State Lives in Native Storage, Never in WebView Storage

**Status:** Settled (2026-08-23)  
**Origin:** Captain decision D17 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [ADR 0004](0004-local-first-pos.md), [docs/operations/android.md](../operations/android.md)

## Context

ADR 0004 makes the POS local-first, which means the device holds sales that exist nowhere else until the outbox drains. During a multi-day outage that can be an entire week of trading. Three things have to survive whatever the tablet goes through in the meantime: the waiting receipts, the 30-day local receipt history (D9), and the device's station number (ADR 0003), without which the tablet cannot issue receipts at all.

The app is a Capacitor wrap of a React app, so the obvious storage — the one every web tutorial reaches for — is the WebView's: `localStorage` or IndexedDB. Both are wrong here, for reasons specific to Android rather than to taste:

- Android evicts WebView storage under storage pressure. The eviction is silent and the app is not consulted.
- "Clear data" and "Clear cache" in Android's app settings wipe WebView storage. That is a routine tap, and it is exactly the tap someone makes when an app is behaving oddly — which is to say, during an outage.

Either would take a week of unsynced sales with no trace and no warning. That is precisely the silent loss D7's "N waiting" marker exists to make visible, so storing the pile somewhere it can silently vanish would defeat the marker along with everything else.

The app already stores the auth token and the active profile in `@capacitor/preferences` — native, app-sandboxed, and not subject to WebView eviction. Nothing else persists locally today.

## Decision

All device state for the offline core lives in the app's own native storage, and the concrete mechanism is **`@capacitor/preferences` with one key per record**.

1. **Never WebView Storage:** No `localStorage`, no IndexedDB, no Cache Storage — not as a primary store and not as a fallback.
2. **One Key Per Record, Never One Blob:** This is what makes key-value storage adequate for 30 days of receipts. A single JSON blob would be re-serialised and rewritten on every save, and a write interrupted mid-receipt would tear the whole history. A key per record writes only the record that changed, and a torn write can cost at most that one record.
3. **Keys Carry Their Own Order:** Outbox and history keys embed a zero-padded monotonic id, so a lexicographic sort of the keys *is* insertion order. No separate index — an index is the one structure in a key-value store that can drift out of step with the records it points at.
4. **One Prefix:** everything sits under `v25.`. That is what makes D15's *survives logout* requirement auditable: the logout path clears `authToken` and `activeProfile` **by name**, and must never become a prefix sweep.
5. **One Seam:** `client/src/offline/nativeStore.js` is the only module that touches `@capacitor/preferences`. Everything above it speaks get / set / remove / keys, so replacing the backend is one file.
6. **Local Browser Dev Falls Back to Memory:** `npm run dev` has no native store, and reaching for the WebView one is forbidden, so dev uses an in-memory map. The machinery runs and can be exercised; nothing survives a reload. A deliberate dev-only limitation, not a storage tier — production is the APK.

## Considered Options

- **Option A: `@capacitor/preferences`, One Key Per Record (Chosen)** — Native and app-sandboxed, already a dependency, no new native plugin and no build change. Backed by Android `SharedPreferences`. At this shop's volume, 30 days is on the order of a thousand receipts of a couple of KB each: low single-digit MB across a thousand-odd keys, well inside what `SharedPreferences` handles.
- **Option B: `@capacitor-community/sqlite` (Rejected for now, held in reserve)** — A real embedded database with indexes and queries, and the right answer if the local store ever outgrows key-value. Rejected now because it adds a native plugin, a build step and a schema-migration story to solve a problem the per-key layout already solves. If the history does outgrow key-value, **this** is the replacement — never a fall back to WebView storage — and `nativeStore.js` is the seam it slots into.
- **Option C: `@capacitor/preferences` Holding One JSON Blob (Rejected)** — The naive key-value shape. Rejected on write cost and on tearing: rewriting the entire history on every sale, with an interrupted write able to lose all of it, is the wrong failure mode for the one store that holds sales existing nowhere else.
- **Option D: IndexedDB (Rejected)** — The natural fit for structured records in a WebView, and what an earlier draft of the design assumed. Rejected outright on Android eviction and "clear data": a store that a routine tap can wipe cannot hold a week of unsynced sales.
- **Option E: The Android Filesystem via `@capacitor/filesystem` (Rejected)** — Durable and native, but it means owning file naming, atomic replacement and corruption recovery by hand, for no advantage over a key-value store already keyed per record.

## Consequences

- 30 days of history is bounded by pruning on start rather than by any storage limit. A receipt whose date cannot be read is kept, not dropped — dropping a record because its date is unreadable is the failure this ADR exists to prevent.
- A "clear data" tap still wipes the app's native storage along with everything else. Nothing can survive that; what this decision buys is that it no longer happens by *accident*, through eviction or a cache clear.
- The dev fallback means the offline path in a browser is exercisable but not durable. Verification that matters happens on the APK (D10).
