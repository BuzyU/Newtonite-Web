# Deployment Guide (Supabase + Render + Vercel)

This guide provides step-by-step instructions to deploy Newtonite to production using Supabase (PostgreSQL 16), Render (Express Node API), and Vercel (React Frontend & Proxy).

---

## Architecture Overview

```
Browser -> Vercel (Static Assets & Proxy /api/*) -> Render (Express API + In-Process Worker) -> Supabase (PostgreSQL 16)
```

- **Vercel:** Hosts the static React build and proxies `/api/*` to Render, creating a single-origin experience with first-party cookies (no CORS issues).
- **Render:** Runs the Node.js 24 API in the `singapore` region. The outbox worker runs in-process (`RUN_WORKER_IN_API=true`).
- **Supabase:** Managed PostgreSQL 16 database in the `singapore` region (to sit adjacent to Render). Connected via the **Session-mode pooler (port 5432)**.

---

## Environment Variable Matrix

The table below details where every configuration variable lives across environments and platforms, whether it contains secrets, and why it is placed there.

| Variable | Target Platform | Type | Purpose & Placement Rationale |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Render, Vercel, Local, CI | Plaintext | Determines execution mode (`production` vs `development` / `test`). Sets cookie security flags and logging formats. |
| `PORT` | Render, Local | Plaintext | Port for Express HTTP listener. Render automatically supplies this; default is `3000` locally. |
| `DATABASE_URL` | Render, GitHub Actions (`production`), Local | Secret | Connection string for PostgreSQL 16 session-mode pooler (port 5432). Required for data queries and migrations. |
| `TEST_DATABASE_URL` | Local, GitHub Actions (CI) | Secret / Config | Connection string for isolated test database (`newtonite_test`). Never pointed at production. |
| `SESSION_SECRET` | Render, Local, GitHub Actions (CI) | Secret | 32+ character entropy string used to sign HTTP-only session cookies with HMAC-SHA256. |
| `APP_ORIGIN` | Render, Local | Config | Authorized CORS origin for browser requests (e.g., `https://newtonite-ops.vercel.app` or `http://localhost:5173`). |
| `APP_URL` | GitHub Repository Variable | Config | Public frontend URL pinged by GitHub Actions keepalive cron workflow every 10 minutes to prevent cold-starts. |
| `DB_POOL_MAX` | Render, Local | Config | Maximum pool connections per Node.js process (defaults to `20`; recommended `5` on Render free tier to stay under Supabase direct connection limits; configured to `50` in concurrency test so 50 requests truly race). |
| `TRUST_PROXY` | Render, Local | Config | Express trust proxy hop count (default `'2'`). Matches Vercel Edge (Hop 1) -> Render Proxy (Hop 2) -> Node.js, ensuring genuine client IP resolution for rate limiting. |
| `RUN_WORKER_IN_API` | Render, Local | Config | When `true`, executes the outbox polling worker in the same Node.js process as the API server. |
| `RENDER_DEPLOY_HOOK_URL`| GitHub Secrets (`production`) | Secret | Webhook URL triggered by GitHub Actions deploy workflow to initiate automated Render rolling deploy. |
| `GOOGLE_LOGIN_ENABLED` | Render, Local | Config | Controls server-side `POST /api/v1/auth/google`. Set to `true` to enable federated Google auth; returns 404 when `false`. |
| `SUPABASE_URL` | Render, Local | Config | Supabase project URL (e.g. `https://xyz.supabase.co`) used by the API to verify access tokens against `/auth/v1/user`. |
| `SUPABASE_PUBLISHABLE_KEY` | Render, Local | Public / Config | Supabase public anonymous API key sent as `apikey` header to `/auth/v1/user`. Never requires or uses `service_role` key. |
| `VITE_GOOGLE_LOGIN_ENABLED` | Vercel, Local | Public Build-time | Controls visibility of the "Continue with Google" button on `/login`. When `false`, button is completely removed from DOM. |
| `VITE_SUPABASE_URL` | Vercel, Local | Public Build-time | Client-side Supabase project endpoint passed to `@supabase/supabase-js` for OAuth redirection. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel, Local | Public Build-time | Client-side Supabase anon key passed to `@supabase/supabase-js`. Safe to bundle in client. |

---

## Step-by-Step Deployment Procedure

### Step 1: Create Supabase Project
1. Log in to [supabase.com](https://supabase.com) and create a new project.
2. **Project Name:** `newtonite-prod` (or your choice).
3. **Region:** Select **Singapore (`ap-southeast-1`)** to minimize latency to Render.
4. Set a strong database password and save it securely.
   > **Note on Special Characters:** If your password contains characters such as `#`, `@`, or `%`, you must percent-encode them in the URL (e.g. `#` becomes `%23`).
5. In Supabase Dashboard, navigate to **Project Settings -> Database -> Connection Pooling**:
   - Select **Mode: Session** (Port: `5432`).
   - Copy the connection URI:
     `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres`
   - *Do NOT use Transaction mode (port 6543):* Transaction mode disables advisory locks and PostgreSQL `LISTEN/NOTIFY`.

---

### Step 2: Configure GitHub Repository Secrets & Variables
In your GitHub repository, navigate to **Settings -> Secrets and variables -> Actions**:

1. Under **Environments**, create an environment named `production`.
2. Add the following **Environment Secret**:
   - `DATABASE_URL`: The Supabase session-pooler string from Step 1.
3. Under **Repository Variables**, add:
   - `APP_URL`: Your Vercel frontend URL (leave blank initially; update after Step 6).

---

### Step 3: Run Database Migrations & Seed Data
1. Migrations run automatically on startup or manually via `npm run migrate`. The migration runner acquires an advisory lock (`78291048123847192`) and executes in strict numerical sequence:
   - `001_initial_schema.sql`
   - `002_indexes_and_views.sql`
   - `003_triggers_and_immutability.sql`
   - `004_rls_and_permissions.sql`
   - `005_google_auth.sql`
2. **Hosted Seed Security:**
   - In production (`NODE_ENV=production`), `npm run seed` will abort unless `ALLOW_PROD_SEED=true` is set.
   - When seeded in production, it generates **cryptographically secure random 24-character passwords** and logs them once to stdout. Working default admin passwords are never published or reused on deployed instances.
3. In GitHub Actions, you can trigger the **Seed Hosted Database** workflow:
   - **Items:** `25000` (hosted default)
   - **Activity:** `200000`
   - **Force:** `false`
4. The workflow populates the database and reports `pg_database_size` (~120 MB, well within the 500 MB limit).

---

### Step 4: Deploy API to Render from Blueprint
1. Log in to [render.com](https://render.com).
2. Click **New + -> Blueprint**.
3. Connect your GitHub repository. Render reads `render.yaml` automatically:
   - Service Type: **Web Service**
   - Runtime: **Node 24**
   - Region: **Singapore**
   - Root Directory: `server`
   - Build Command: `npm ci --include=dev && npm run build`
   - Start Command: `npm run start`
   - Health Check Path: `/api/v1/health`
   - Auto-deploy: `false`
4. When prompted for environment variables:
   - `DATABASE_URL`: Paste the Supabase session-pooler connection string from Step 1.
   - `APP_ORIGIN`: Enter temporary value `http://localhost:5173` (we will update this in Step 7).
5. Click **Apply**.
6. Once created, open the service settings:
   - Under **Deploy Hook**, click **Create Deploy Hook**.
   - Copy the URL (e.g. `https://api.render.com/deploy/srv-xxxx?key=yyyy`).
7. In GitHub, add this deploy hook as an environment secret in `production`:
   - `RENDER_DEPLOY_HOOK_URL`: Your Render deploy hook URL.

---

### Step 5: Update Vercel Proxy Configuration
1. Note your Render service hostname (e.g. `newtonite-api.onrender.com`).
2. Open [web/vercel.json](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web/vercel.json):
   ```json
   {
     "rewrites": [
       {
         "source": "/api/:path*",
         "destination": "https://newtonite-api.onrender.com/api/:path*"
       },
       {
         "source": "/(.*)",
         "destination": "/index.html"
       }
     ]
   }
   ```
3. Replace `REPLACE_WITH_RENDER_HOST` with your exact Render hostname.
4. Verify locally using the check script:
   ```bash
   npm --prefix web run check:deploy
   ```
   *Must output: `[DEPLOY CHECK PASSED]`.*
5. Commit and push this change to `main`.

---

### Step 6: Deploy Frontend to Vercel
1. Log in to [vercel.com](https://vercel.com) and click **Add New -> Project**.
2. Import your GitHub repository.
3. Configure project settings:
   - **Root Directory:** Edit and select `web`.
   - **Framework Preset:** Vite.
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. No environment variables are needed on Vercel.
5. Click **Deploy**.
6. Copy your assigned Vercel URL (e.g. `https://newtonite-ops.vercel.app`).

---

### Step 7: Finalize Origin & Keepalive
1. In the **Render Dashboard -> Environment**, update:
   - `APP_ORIGIN`: Set to your final Vercel URL (e.g. `https://newtonite-ops.vercel.app`).
   - Click **Save Changes** and manual deploy (or trigger via deploy hook).
2. In **GitHub Repository Settings -> Variables -> Actions**:
   - Set `APP_URL`: Your final Vercel URL (e.g. `https://newtonite-ops.vercel.app`).
3. This activates the `keepalive.yml` workflow to ping `/api/v1/ready` every 10 minutes, preventing Render sleep and Supabase inactivity pauses.

---

## Smoke Test Checklist

After completing deployment, verify the live platform:

- [ ] **Health Checks:**
  - Visit `https://<VERCEL-APP>/api/v1/health` -> returns `{"status":"ok"}`.
  - Visit `https://<VERCEL-APP>/api/v1/ready` -> returns `{"status":"ready"}`.
- [ ] **Authentication:**
  - Open `https://<VERCEL-APP>/login`.
  - Click the demo chip for **Priya Patel** (`priya@newtonite.internal`).
  - Successfully signs in and lands on **My Attention**.
- [ ] **Create Work Item:**
  - Click **+ New Item** (or press `c`).
  - Create a new item for team **Operations**.
  - Detail page loads with reference (e.g. `OPS-1001`), version `v1`.
- [ ] **Two-Browser Claim Race:**
  - Open an unassigned item in two browsers.
  - Click **Claim** in both. One gets 200 (assigned), the other gets 409 (`ALREADY_CLAIMED`) with winner's name.
- [ ] **Stale-Edit Conflict Panel:**
  - Edit the same item in two tabs. Save tab 1, then save tab 2. Tab 2 shows 412 conflict panel with differences and re-apply button.
- [ ] **Realtime Indicator:**
  - Check the top-bar indicator: displays `Live` or `Polling`.
- [ ] **Outbox & Dead Letters:**
  - Open **Dead Letters (Admin)**: displays zero parked errors.

---

## Troubleshooting Table

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **API takes 50s on first load** | Render free-tier instance cold start after 15 min idle. | Expected behavior. Client shows wake-up banner. GitHub `keepalive.yml` ping mitigates this during demo periods. |
| **Session cookie not set after login** | Mismatched origins or non-https connection. | Ensure browser connects to Vercel via HTTPS. Confirm Vercel proxies `/api/*` so requests are same-origin. |
| **502 Bad Gateway from Vercel rewrite** | Render hostname in `web/vercel.json` is incorrect or Render API is building. | Check `web/vercel.json` destination URL. Check Render service deployment logs. |
| **Advisory lock or LISTEN error on DB** | Connected via Supabase transaction pooler (port 6543). | Switch Supabase connection string to session-mode pooler on **port 5432**. |
| **Supabase project shows "Paused"** | Free project had 7 consecutive days of inactivity. | Unpause project in Supabase dashboard. Confirm GitHub repository variable `APP_URL` is set to run keepalive. |
| **Build fails: module not found in server** | Render build stripped devDependencies. | Ensure Render build command includes `--include=dev`: `npm ci --include=dev && npm run build`. |
| **Database connection SSL error** | Missing root CA cert on strict verification. | Ensure `server/src/db.ts` uses `{ rejectUnauthorized: false }` when `DB_SSL_CA` is not provided. |
