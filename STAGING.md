# Staging Environment — Leyble Hub

This document describes the staging deployment environment and how to use it in your development workflow.

---

## Overview

**Staging** is a full clone of production (same code, same schema, separate databases and Render
services) where family members can test and practice without touching real production data.

- **Staging Render service:** `leyble-hub-api-staging` (deployed from `staging` branch)
- **Staging Supabase project:** separate instance with a one-time copy of prod data
- **Staging URL:** available in the Render dashboard once deployed (e.g.,
  `https://leyble-hub-api-staging.onrender.com`)
- **Staging branch:** `staging` (third branch in the repo alongside `main` and `android-app`)

---

## Setting up staging (one-time setup)

### 1. Create a new Supabase project

1. Go to [supabase.com](https://supabase.com), log in.
2. Create a new project (e.g., `leyble-hub-staging`), same region as production for low latency.
3. Wait for the project to provision. Copy the **pooled connection string** from the project
   settings (under "Database" → "Connection pooling" → "PostgreSQL").
   - Format: `postgresql://postgres:[PASSWORD]@[HOST]:6543/postgres`
   - Save this for step 3 below.

### 2. Clone prod data into staging (one-time, run locally)

```bash
# Get your prod Supabase pooled connection string from the prod project settings.
# (PROD_DB_URL and STAGING_DB_URL below — substitute your actual URLs)

PROD_DB_URL="postgresql://postgres:..."    # from prod Supabase
STAGING_DB_URL="postgresql://postgres:..." # from staging Supabase

# Dump prod data
pg_dump --no-owner --no-acl -Fc "$PROD_DB_URL" -f prod_dump.dump

# Restore into staging (--clean removes any existing tables first, --if-exists is safe)
pg_restore --no-owner --no-acl -d "$STAGING_DB_URL" --clean --if-exists prod_dump.dump

echo "Data cloned! Staging now has all prod schema + data."
```

This copies:
- All tables (users, products, customers, orders, etc.)
- All data (existing accounts, login credentials, product catalog, customer data, etc.)
- The `_migrations` tracking table (so staging DB is at the same migration version as prod)

**Important:** Family members can now log in to staging with their existing production credentials
(same email/password).

### 3. Set staging DATABASE_URL in Render dashboard

1. Go to [render.com](https://render.com), log in, navigate to your `leyble-hub` project.
2. Find the `staging` environment and the `leyble-hub-api-staging` service.
3. Open **Settings** → **Environment** → find the `DATABASE_URL` variable.
4. Paste the staging Supabase pooled connection string you saved in step 1.
5. **Save** — the staging service will redeploy automatically.
6. Wait for the build to finish (1–3 minutes). The health check endpoint
   (`https://<staging-url>/health`) should respond `{"status":"ok"}`.

### 4. Verify staging works

1. Open the staging URL in a browser (find it in the Render dashboard under the `leyble-hub-api-staging`
   service — it'll be something like `https://leyble-hub-api-staging-something.onrender.com`).
2. Log in with a family member's production account (same email/password as prod — they were
   cloned).
3. Create a test order or make a small change.
4. Check the production app — the test order should **not** appear. Verify staging and prod are
   fully isolated.

---

## Development workflow: android-app → staging → main

Once staging is live, use this workflow for safer deployments:

### Normal feature or fix (low-risk, test on staging first):

1. **Make changes on `android-app`** (your active dev branch):
   ```bash
   git checkout android-app
   # ... edit files, test locally ...
   git commit -m "Add feature X"
   ```

2. **Merge into `staging` and push**:
   ```bash
   git checkout staging
   git merge android-app
   git push origin staging
   ```
   Render's `staging` environment auto-deploys. Wait 1–3 minutes for the build to finish.

3. **Test on the staging URL** (browser or family members test):
   - Open the staging app, log in, test the new feature.
   - Verify it works and doesn't break other features.
   - Check the Audit Log to see your changes reflected.

4. **If it works, merge into `main` and push**:
   ```bash
   git checkout main
   git merge staging
   git push origin main
   ```
   Render's `production` environment auto-deploys. Production is now updated.

5. **If it doesn't work**, fix the issue on `android-app`, re-merge, and push to `staging` again.
   Staging redeploys until the fix is verified. Then merge into `main`.

### Emergency hotfix (skip staging, go straight to prod):

For critical bugs or urgent fixes that need immediate production deployment:

1. **Fix on `android-app`**:
   ```bash
   git checkout android-app
   # ... fix, test locally ...
   git commit -m "Fix critical bug Y"
   ```

2. **Merge directly into `main`** (skip staging):
   ```bash
   git checkout main
   git merge android-app
   git push origin main
   ```
   Production redeploys immediately. Staging stays on its previous commit (unaffected).

3. **Later, sync staging with prod** (keep them in sync):
   ```bash
   git checkout staging
   git merge main
   git push origin staging
   ```
   Staging now includes the fix for testing purposes going forward.

---

## Branches summary

| Branch | Purpose | Deploys to | Auto-deploys on push |
|--------|---------|------------|----------------------|
| `android-app` | Your active dev branch | (none — local only) | (no) |
| `staging` | Staging environment | Render staging service | Yes, `staging` environment |
| `main` | Production environment | Render prod service | Yes, `production` environment |

---

## Key points

- **Staging = a full clone, but separate.** Same code, same DB schema, separate data. Family
  members can test freely; production is never touched.
- **Branches drive deployments.** Push to `staging` → staging redeploys. Push to `main` →
  production redeploys. Each is independent.
- **Data divergence is expected.** After the one-time clone, staging and prod have separate data.
  Test orders in staging won't appear in prod. New production orders won't appear in staging
  unless you manually clone again (rarely needed).
- **JWT secrets are separate.** Render auto-generates a different `JWT_SECRET` for each
  environment, so login sessions never overlap between prod and staging.
- **No Android APK yet.** Staging is web/PWA-only for now (family opens the staging URL in a
  browser and can "Add to Home Screen"). A separate staging APK can be added later if needed.

---

## Useful links

- **Prod Render service:** see `render.yaml` under `projects.leyble-hub.environments.production`
- **Staging Render service:** see `render.yaml` under
  `projects.leyble-hub.environments.staging`
- **Supabase prod dashboard:** [supabase.com](https://supabase.com) → prod project
- **Supabase staging dashboard:** [supabase.com](https://supabase.com) → staging project
- **Render blueprint docs:** [render.com/docs/blueprint-spec](https://render.com/docs/blueprint-spec)
