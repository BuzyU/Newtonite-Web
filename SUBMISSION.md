# Submission Summary

---

## Technology Stack Used

Newtonite is built on Node.js 24 LTS across both backend and frontend without monorepo workspaces. The backend uses Express, strict Zod validation, `pg` (node-postgres), and Pino structured logging against PostgreSQL 16 with advisory-locked raw SQL migrations. The frontend is built with React 19, Vite, TypeScript strict, TanStack Query, React Router, and a dense 13px operational design system written in plain CSS variables and CSS modules with self-hosted IBM Plex fonts. Asynchronous operations rely on a PostgreSQL transactional outbox polled via `FOR UPDATE SKIP LOCKED` and real-time Server-Sent Events (SSE) backed by a dedicated PostgreSQL `LISTEN/NOTIFY` client. Testing uses Vitest, Supertest, and React Testing Library against real PostgreSQL 16. The deployment pipeline uses GitHub Actions CI/CD to target Supabase (session-mode pooler), Render (Node API with in-process worker), and Vercel (static React frontend and `/api/*` proxy rewrite).

---

## Key Engineering Decisions

Newtonite implements strict operational guarantees in PostgreSQL 16 rather than delegating reliability to external brokers. Concurrency is handled at three distinct layers: single-statement conditional updates guarantee atomic claims with exactly one winner (`assignee_id IS NULL`), while ETags and integer versions enforce optimistic concurrency control (`If-Match`) to reject stale writes with HTTP 412 instead of silent last-write-wins. Mutating operations mandate client-generated idempotency keys, which reserve status in an atomic table and cache completed responses to ensure safe browser retries. Multi-tenant authorization is enforced directly within SQL joins rather than controllers; accessing unassigned or foreign-team items returns HTTP 404 to eliminate resource enumeration. Asynchronous side effects (audit trails, notifications, SLA monitors) are written to a transactional outbox table within the business transaction and drained via `FOR UPDATE SKIP LOCKED` with lease expirations and exponential backoff. Keyset pagination ordered by `(last_activity_at DESC, id DESC)` paired with composite B-tree, generated `tsvector` GIN, and trigram indexes ensures sub-millisecond query execution regardless of dataset depth.

---

## Things to Be Ready to Explain in Review

1. **Atomic Claim & Optimistic Concurrency Control**
   - **File:** [server/src/items.ts](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/items.ts)
   - **Key Concept:** Why `UPDATE items ... WHERE id = $1 AND assignee_id IS NULL` guarantees exactly one winner with zero deadlocks, and how the `If-Match` header maps to integer versions and returns HTTP 412 with the current server entity for client-side resolution.

2. **Resource-Level Authorization Enforced in SQL (404 vs 403)**
   - **Files:** [server/src/policy.ts](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/policy.ts) and [server/src/items.ts](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/items.ts)
   - **Key Concept:** Why queries join `team_memberships` directly in SQL rather than relying on controller logic, and why foreign-team items return `404 NOT FOUND` to prevent ID enumeration.

3. **Two-Phase Idempotency Key Reservation**
   - **File:** [server/src/idempotency.ts](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/idempotency.ts)
   - **Key Concept:** Why inserting the key row first with `status = 'in_progress'` protects against simultaneous in-flight duplicates (returning HTTP 409 `REQUEST_IN_PROGRESS`), compares payload hashes (returning 422 on mismatch), and safely replays completed responses without re-executing business logic.

4. **Transactional Outbox Worker with Lease Reclaiming**
   - **File:** [server/src/worker.ts](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/src/worker.ts)
   - **Key Concept:** How `SELECT ... FOR UPDATE SKIP LOCKED` enables concurrent worker scaling without contention, how `lease_expires_at` automatically recovers crashed workers, and how deduplication keys ensure idempotent side-effect execution.

5. **Activity Log Immutability via Database Trigger**
   - **File:** [server/migrations/003_triggers_and_immutability.sql](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/migrations/003_triggers_and_immutability.sql)
   - **Key Concept:** Why a PostgreSQL trigger raising exceptions on `UPDATE`, `DELETE`, and `TRUNCATE` is necessary instead of relying on `REVOKE` permissions (because hosted platforms like Supabase connect as superuser `postgres`).
