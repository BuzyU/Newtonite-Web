# Live-Review Technical Cheat Sheet: "Operations Under Pressure"

This cheat sheet equips the engineer with crisp, defensive answers, source citations, and verified test proofs for every critical architecture question in a live technical review.

---

## 1. Concurrency & Atomic Claims

### Question: "How do you handle two or fifty operators clicking 'Claim' at the exact same millisecond?"
- **Answer:** We execute a **single conditional atomic `UPDATE`** inside a short PostgreSQL transaction:
  ```sql
  UPDATE items
  SET assignee_id = $1, status = $2, version = version + 1, updated_at = NOW(), last_activity_at = NOW()
  WHERE id = $3 AND assignee_id IS NULL AND status NOT IN ('resolved', 'closed') AND archived_at IS NULL
  RETURNING *;
  ```
  PostgreSQL takes an exclusive row-level lock on the target item. The first transaction to acquire the lock matches `assignee_id IS NULL`, sets `assignee_id = $1`, increments `version`, and commits (HTTP 200). All subsequent concurrent transactions queue momentarily on the row lock; when released, the row's `assignee_id` is no longer NULL, matching zero rows (`RETURNING *` yields empty set).
- **Conflict Handling:** When zero rows are returned, the transaction rolls back, reads the winning operator's name and email, and returns `409 Conflict` (`ALREADY_CLAIMED`) with `{ currentAssignee: { id, name, email } }`.
- **Proof:** [`server/tests/concurrency.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/concurrency.test.ts). Configures `DB_POOL_MAX=50` to provision 50 dedicated database connections. 50 parallel requests truly race: exactly 1 returns 200, exactly 49 return 409.

---

## 2. Optimistic Concurrency Control (OCC) & Stale Edits

### Question: "How do you prevent operator A from silently overwriting operator B's edits?"
- **Answer:** Every work item maintains a monotonic integer `version` incremented on every state or attribute change.
  - The API emits an `ETag: "1"` response header on `GET /items/:id`.
  - Mutating operations (`PATCH /items/:id`, transitions, approve, reject, reopen) require an `If-Match: "1"` request header.
  - In SQL:
    ```sql
    SELECT * FROM items WHERE id = $1 AND archived_at IS NULL FOR UPDATE;
    if (currentItem.version !== expectedVersion) {
      return res.status(412).json({ error: { code: 'STALE_VERSION', ... } });
    }
    ```
- **Proof:** [`server/tests/occ.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/occ.test.ts) & [`web/tests/stale-edit.test.tsx`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web/tests/stale-edit.test.tsx).

---

## 3. Client & Server Idempotency (CONC-02)

### Question: "What happens if a network glitch causes the client to retry a submission? What if the user double-clicks?"
- **Client Side ([`web/src/api.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web/src/api.ts)):**
  - The client generates **one `Idempotency-Key` (UUIDv4) per user intent** (e.g. on clicking Submit).
  - During automatic network retries (exponential backoff on 502/503/504/network errors), the **exact same key is reused**.
  - If the user alters the form or submits again after an error, a **brand new key is generated**.
  - Double-click protection: button disables immediately and request ref tracks inflight mutations.
- **Server Side ([`server/src/idempotency.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/idempotency.ts)):**
  - **Scoped Per User:** `PRIMARY KEY (user_id, idempotency_key)`. User A cannot collide with or hijack User B's keys.
  - **Request Hashing:** `SHA256(userId + method + path + canonicalJsonStringify(body))`. Canonicalization recursively sorts object keys so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce identical hashes.
  - **Two-Phase Reservation:**
    1. Inserts `status = 'in_progress'`. If another identical request arrives while in flight, returns `409 REQUEST_IN_PROGRESS`.
    2. On completion, updates `status = 'completed'` with cached response body, status code, and headers.
    3. Replayed requests return the cached response with header `X-Cache: HIT`.
  - **5xx Safety Guarantee:** If a handler throws an unhandled internal 5xx error, `completeIdempotency` deletes the key ONLY if `status != 'completed'`. This guarantees that if a committed effect occurred (200/201/204), the key is never deleted.
- **Proof:** [`server/tests/idempotency.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/idempotency.test.ts) & [`web/tests/idempotency-client.test.tsx`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web/tests/idempotency-client.test.tsx).

---

## 4. Work Transitions & Separation of Duties

### Question: "How are roles, approvals, and audit logs enforced?"
- **Role Hierarchy ([`server/src/policy.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/policy.ts)):**
  - `admin` (Org Admin): Full access across all teams.
  - `lead` (Team Lead): Can triage, assign, update, transition, approve, reject, reopen.
  - `member`: Can claim, work on items, submit for approval, comment.
  - `viewer`: Read-only.
- **Separation of Duties (Creator != Approver):**
  - An item moving to `resolved` via `POST /items/:id/approve` enforces that `user.id !== item.reporter_id`. The person who created the item cannot sign off on their own work.
- **Transactional Audit & Outbox:**
  - Every transition writes to `activity_log` and `outbox_events` in the **exact same transaction**.
  - `activity_log` has a PostgreSQL trigger (`prevent_activity_mutation`) preventing `UPDATE`, `DELETE`, or `TRUNCATE`.
- **Proof:** [`server/tests/approve_reject.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/approve_reject.test.ts).

---

## 5. Token Verification & Authentication Security

### Question: "How do you validate Google OAuth tokens, and how do you prevent account takeover?"
- **Token Validation ([`server/src/tokenValidator.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/tokenValidator.ts)):**
  - Verified against Supabase `/auth/v1/user` using the public anon key (never `service_role`).
  - Strict assertions:
    1. Signature & HTTP 200 from authorization server.
    2. Issuer matches expected URL (`${SUPABASE_URL}/auth/v1`).
    3. Audience matches `'authenticated'`.
    4. Expiry: token must not be expired (`exp * 1000 > Date.now()`).
    5. **`email_verified` check:** Must be explicitly `true` (`user_metadata.email_verified === true` or `identities[].identity_data.email_verified === true`).
- **Account Linking Security:**
  - When mapping a verified Google identity to an existing account, the user must have an active password account AND the provider email must be verified.
  - If `email_verified` is false or missing, registration/login is rejected with `403 UNVERIFIED_EMAIL`. Unverified third-party emails are NEVER automatically linked to existing accounts.
- **Proof:** [`server/tests/google_auth.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/google_auth.test.ts).

---

## 6. Server-Sent Events (SSE) & Real-Time Scoping

### Question: "Who receives SSE events? What happens if a team member is removed while their browser tab is open?"
- **Dynamic Membership Check ([`server/src/sse.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/sse.ts)):**
  - We do not rely on static connection-time membership lists. On **every broadcast**, the broadcaster queries PostgreSQL `team_memberships` in real time to verify the client is still an active team member.
  - If an operator has been removed from the team, the event is immediately withheld.
  - A helper `dropUserSseClients(userId, teamId)` closes connections on membership changes.
- **Unscoped Events:**
  - Events that lack a `team_id` (e.g. system-wide dead letters, global announcements) are **strictly delivered only to Org Admins** (`user.is_org_admin === true`). Regular team members never receive unscoped events.
- **Reconnection (`Last-Event-ID`):**
  - If a client disconnects, it reconnects with the `Last-Event-ID` header. The server streams missed events from `outbox_events` starting after that ID.
- **Proof:** [`server/tests/sse.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/sse.test.ts).

---

## 7. Outbox Worker & Multi-Worker Coordination

### Question: "How do multiple worker instances process the outbox without duplicate deliveries?"
- **Locking Primitive ([`server/src/worker.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/worker.ts)):**
  ```sql
  SELECT * FROM outbox_events
  WHERE status = 'pending' AND (locked_until IS NULL OR locked_until < NOW())
  ORDER BY created_at ASC
  LIMIT 20
  FOR UPDATE SKIP LOCKED;
  ```
  `SKIP LOCKED` guarantees that each worker claims a non-overlapping slice of events. Neither worker waits on the other, eliminating lock contention.
- **At-Least-Once Delivery & Deduplication:**
  - Every side effect uses a deterministic deduplication key (`dedupe_key = event.id + handler_name`).
- **Multi-Worker Test:**
  - [`server/tests/outbox.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/outbox.test.ts): 2 workers concurrently poll and process 20 events. The test asserts that total completed == 20, zero duplicates, and zero deadlock errors (regardless of split between workers).

---

## 8. Rate Limiting & Trust Proxy Configuration

### Question: "How do you rate limit across proxies, and what are the limitations?"
- **Trust Proxy ([`server/src/app.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/app.ts)):**
  - Configured via `TRUST_PROXY` (default: `'2'`).
  - Matches the production topology: `Client -> Vercel Edge (Hop 1) -> Render Proxy (Hop 2) -> Node.js`.
  - Express evaluates `X-Forwarded-For` from right to left, selecting the genuine client IP 2 hops back and preventing client header spoofing.
- **In-Memory Limitations ([`KNOWN_LIMITATIONS.md`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/KNOWN_LIMITATIONS.md)):**
  - Login rate limiter (5 attempts/15min) and write rate limiter (120 writes/min) use in-process maps.
  - Counters reset on container restart and do not aggregate across horizontal replicas. The production path is Redis / Valkey sliding-window counters.
- **Proof:** [`server/tests/rate_limit.test.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests/rate_limit.test.ts).

---

## 9. Production Seed & Security Hygiene

### Question: "Are demo credentials active in production?"
- **Answer:**
  - **Frontend:** Demo login chips on `/login` are displayed **only** when `import.meta.env.DEV` or `VITE_ENABLE_DEMO_LOGIN=true`. In a production build, they are completely omitted from the bundle.
  - **Backend Seed ([`server/src/seed.ts`](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/seed.ts)):** `npm run seed` aborts in production (`NODE_ENV=production`) unless explicitly overridden with `ALLOW_PROD_SEED=true`. When run, it generates **cryptographically secure random 24-character passwords** and outputs them to stdout once. No static default passwords exist on deployed instances.

---

## 10. Database Migrations List

The canonical migrations executed in exact numerical order:
1. `001_initial_schema.sql` — Core tables (`users`, `teams`, `team_memberships`, `items`, `comments`, `outbox_events`, `idempotency_keys`).
2. `002_indexes_and_views.sql` — Composite B-trees, GIN trigram indexes, and `items_summary_view`.
3. `003_triggers_and_immutability.sql` — Immutability trigger on `activity_log` and `notify_outbox_event_created()` trigger for PostgreSQL `LISTEN/NOTIFY`.
4. `004_rls_and_permissions.sql` — Row Level Security policies for tenant isolation.
5. `005_google_auth.sql` — Google/OAuth identity mapping and `google_sub` constraint.
