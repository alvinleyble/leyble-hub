# V1 and V2 Dual-App Coexistence on User Devices

**Status:** Superseded (2026-08-22 by V2.0 Slice 5 in PR #26; further superseded 2026-08-25 by V3.0)  
**Origin:** Captain directive (2026-08-20)  
**See also:** [docs/product/proposals/v2-tablet-pos-overhaul.md](../product/proposals/v2-tablet-pos-overhaul.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

*(Note: In V3.0, the separate V2 screens, `/v2/*` routes, and the V1↔V2 3-second long-press switching bridge were removed entirely [G12, G17]. V1 is the sole application, embedding the POS-style order creation modal directly inside Outgoing Orders).*

## Context

Store owners in Antipolo operate on an Honor Pad X8B tablet. The V1 app (`com.leyble.hub`, named "Leyble Hub") provides full desktop/admin capabilities (Personnel, Incoming Supplies, Tickets, Audit Log, 11-step Orders), while the V2 app provides an ultra-fast, 2-tap POS workflow (`/v2/pos`), Inventory price management (`/v2/inventory`), and Suki customer profiles (`/v2/customers`).

The captain decided that users must have access to **both V1 and V2 concurrently** on their devices. The backend Express API and PostgreSQL database remain 100% unified and shared between both versions in real-time.

## Decision

We are packaging and installing V2 as a **distinct Android application** alongside the existing V1 installation on user devices, rather than destructively overwriting V1 or requiring in-app mode toggling:

1. **V1 App Profile:**
   - **App Name:** `Leyble Hub` (or `Leyble Hub Classic`)
   - **Application ID:** `com.leyble.hub`
   - **Default Landing:** `/dashboard` (classic admin shell)

2. **V2 App Profile:**
   - **App Name:** `Leyble Hub POS`
   - **Application ID:** `com.leyble.hub.pos`
   - **Default Landing:** `/v2/pos` (V2 tablet shell)

3. **Data & Backend Synchronicity:**
   - Both apps point to the exact same cloud API backend and Supabase PostgreSQL instance.
   - Orders finalized in V2 POS deduct stock and appear instantly in V1 order history and audit logs.
   - Suki custom pricing and catalog changes sync in real-time between both interfaces.

## Considered Options

- **Option 1: Two Separate Installed Apps on Device (Chosen)** — Separate package IDs (`com.leyble.hub` vs `com.leyble.hub.pos`). Provides two dedicated launcher icons on the tablet home screen ("Leyble Hub POS" for counter sales, "Leyble Hub" for back-office). Zero confusion for non-technical users in their late 50s; installing V2 does not disturb or replace the proven V1 build.
- **Option 2: Single App with In-App Switcher (Rejected)** — Single package ID with a toggle button between Classic and V2. Rejected because it adds navigation friction and cognitive overhead on tablet hardware during busy counter operations.
- **Option 3: Full Replacement of V1 by V2 (Rejected)** — Overwriting V1 entirely. Rejected because back-office modules (incoming supplies, tickets, personnel management) are retained in their V1 interface and users still rely on the full V1 portal for complex operational reviews.
