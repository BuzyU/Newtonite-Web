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
1. In your GitHub repository, navigate to the **Actions** tab.
2. Trigger the automated migration by pushing to `main` (or run manually via `npm run migrate` with `DATABASE_URL`).
3. Under Actions, select **Seed Hosted Database** -> click **Run workflow**:
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
