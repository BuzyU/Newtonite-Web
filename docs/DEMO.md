# Demonstration Script (6–8 Minutes)

This script walks through the critical operational workflows, concurrency guarantees, and authorization rules of the Newtonite platform using two browser windows (or one regular window and one incognito window).

---

## Preparation (1 Minute)

1. **Start the local platform:**
   ```bash
   npm run dev
   ```
   - Server runs on `http://localhost:3000`
   - Frontend runs on `http://localhost:5173`

2. **Open Two Browser Windows Side by Side:**
   - **Browser A (Window 1):** `http://localhost:5173`
   - **Browser B (Incognito / Window 2):** `http://localhost:5173`

---

## Step 1: Authentication & Per-Team Scoping (1 Minute)

1. **Browser A:** On the login screen, click the demo chip for **Priya Patel** (`priya@newtonite.internal` / `demo-password-123`).
   - Notice: Priya is **Lead in Operations** and **Viewer in Engineering**.
2. **Browser B:** On the login screen, click the demo chip for **Elena Rostova** (`elena@newtonite.internal` / `demo-password-123`).
   - Notice: Elena is **Lead in Engineering**.
3. **Verify Resource Scoping:**
   - In Browser A, click **All Work**. Filter by Team -> **Operations**. Items display normally.
   - Filter by Team -> **Engineering**. Items display with read-only controls (Priya has viewer permissions in Engineering).
   - Attempt to access an arbitrary item or non-member item directly via URL: non-member items return **404 NOT FOUND** (never 403), preventing enumeration attacks.

---

## Step 2: Atomic Claim Race Condition (1.5 Minutes)

Demonstrate that exactly one user wins an item claim when two members click concurrently:

1. **Browser A (Priya):**
   - Click **+ New Item** (or press keyboard shortcut `c`).
   - Team: **Operations**
   - Title: `Critical: Database pool starvation on payment webhook`
   - Description: `High connection count causing timeouts on reconciliation job.`
   - Priority: `Urgent`
   - Assignee: Leave as **Unassigned**.
   - Click **Create Item**.
   - Copy the item URL (e.g. `/items/<uuid>`).

2. **Browser B (Elena or Arjun):**
   - Paste the item URL into Browser B.
   - Both browser windows now view the same unassigned item.
   - Notice the status: `new`, Assignee: `Nobody owns this yet`.

3. **Simultaneous Claim:**
   - Click **Claim This Item** in **Browser A**, then immediately click **Claim This Item** in **Browser B**.
   - **Outcome in Browser A:** Receives HTTP 200, status updates to assigned to Priya.
   - **Outcome in Browser B:** Receives HTTP 409 `ALREADY_CLAIMED`. The UI displays: *"Already claimed by Priya Patel"* without breaking.
   - Check the Activity History: Exactly **one** claim event is recorded.

---

## Step 3: Optimistic Concurrency & Stale-Edit Conflict Panel (1.5 Minutes)

Demonstrate that silent last-write-wins is strictly prevented via ETags and versioning:

1. Both browsers remain on the same item detail page (current version `v2`).
2. **Browser A (Priya):**
   - Click **Edit Details**.
   - Update title to: `Critical: Database pool starvation (Resolved by increasing DB_POOL_MAX to 10)`.
   - Do **NOT** click Save yet.
3. **Browser B (Elena):**
   - Click **Edit Details**.
   - Change Priority to `High`.
   - Click **Save**.
   - Browser B succeeds (version increments to `v3`).
4. **Browser A (Priya):**
   - Now click **Save** in Browser A (which sent `If-Match: "2"`).
   - **Result:** Server rejects with HTTP 412 `STALE_VERSION`.
   - **UI Behavior:** Browser A displays the **Concurrency Conflict Panel**:
     - *"Another team member updated this item before your changes were saved."*
     - Shows current server state (`v3`, Priority `high`).
     - Offers two actions:
       - **"Discard my edits & load latest"**
       - **"Re-apply my edits to latest (v3)"**
   - Click **"Re-apply my edits to latest"**: the edit re-submits with the current version and successfully updates.

---

## Step 4: State Machine & Separation of Duties (2 Minutes)

Demonstrate business rules for approval and separation of duties:

1. In Browser A, create an item with **"Requires Lead Approval before resolving"** checked:
   - Team: `Operations`
   - Title: `Payment gateway settlement discrepancy`
   - Description: `Requires double sign-off from team lead before closing ledger.`
   - Check: `Requires Lead Approval before resolving`.
   - Assignee: Assign to **Arjun Das** (Ops Member).

2. In Browser B, log in as **Arjun Das** (`arjun@newtonite.internal` / `demo-password-123`).
   - Open the item.
   - Status is `new`. Click **Mark Triaged** -> status becomes `triaged`.
   - Click **Start Progress** -> status becomes `in_progress`.
   - Click **Submit for Lead Approval** -> status becomes `awaiting_approval`.
   - Notice: Arjun (current assignee) **cannot** approve the item. Separation of duties requires an independent lead.

3. In Browser A (Priya Patel, Ops Lead):
   - Navigate to **My Attention**.
   - The item appears under **Awaiting Lead Approval**.
   - Click **Review**.
   - Click **Approve & Resolve**, enter note: *"Reconciled with bank statement batch 4029. Approved."*
   - Status transitions to `resolved`.
   - Activity log captures: *"Priya Patel approved this item with note: 'Reconciled with bank statement batch 4029. Approved.'"*

---

## Step 5: Real-Time SSE Updates & Outbox Worker (1 Minute)

1. Keep Browser A and Browser B visible side by side.
2. In Browser A, post a comment: `Investigating server logs now @arjun`.
3. Watch Browser B: Browser B's comment list and attention queue update in real time via Server-Sent Events without manual page refresh.
4. Top bar displays the active connection indicator (`Live` with green pulse).
5. Open **Dead Letters (Admin)** in the sidebar to review the status of the background outbox worker.
