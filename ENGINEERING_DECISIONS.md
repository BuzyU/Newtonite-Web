# Key Engineering Decisions

This document records the foundational architecture and engineering trade-offs made in building Newtonite.

---

## 1. Resource Scoping in SQL with 404 for Non-Member Entities

- **Context:** Newtonite supports multi-tenant teams where members hold per-team roles (Viewer, Member, Lead, Admin). Unauthorised data access must be impossible.
- **Options Considered:**
  1. *Application-level filtering in controllers:* Fetch items by ID, then run `if (item.team_id not in user.teams) return 403`.
  2. *Resource scoping inside SQL joins:* Every query (`SELECT`, `UPDATE`) joins directly on `team_memberships` filtered by caller `user_id`. Non-matching items return 0 rows.
- **Decision:** Scoping is enforced **in SQL**. Queries join caller memberships; non-member items return HTTP `404 NOT FOUND`.
- **Trade-offs:** Every query requires an extra join condition. In exchange, data leaks are structurally impossible regardless of controller bugs. Returning 404 instead of 403 prevents attackers from probing which UUIDs exist.
- **What changes at 10x:** Read queries route through read replicas, with memberships cached in a session token or fast lookup index.

---

## 2. Optimistic Versioning (ETags/If-Match) & Atomic Claims

- **Context:** Multiple team members concurrently triage, claim, and edit items under high operational pressure.
- **Options Considered:**
  1. *Pessimistic table/row locking during edits:* Lock the item row while a user opens the edit modal.
  2. *Last-write-wins:* The latest HTTP request silently overwrites database fields.
  3. *Optimistic concurrency control with ETags + single-statement atomic claim:* Every item has an integer `version`. Mutations require `If-Match`. Claims use a single conditional `UPDATE ... WHERE assignee_id IS NULL`.
- **Decision:** OCC via `version` and HTTP 412 `STALE_VERSION`. Single-winner atomic claim in SQL.
- **Trade-offs:** Requires the client to handle 412 conflicts gracefully with a difference panel. In exchange, team members never overwrite each other's edits, and double-claims have exactly one winner with zero lock timeouts.
- **What changes at 10x:** Field-level conflict resolution or operational transformation for concurrent rich-text notes.

---

## 3. Idempotency Keys with Two-Phase Key Reservation

- **Context:** Unreliable networks and timeouts cause browser retries of item creation and status transitions.
- **Options Considered:**
  1. *Blind retries:* Mutating endpoints re-execute on every POST.
  2. *Two-phase key reservation:* The server inserts an `idempotency_keys` record first (`status = 'in_progress'`, request hash). If a duplicate request arrives while running, it gets 409 `REQUEST_IN_PROGRESS`. If replayed after completion, it returns the cached response. If the payload differs, it returns 422.
- **Decision:** Two-phase idempotency key reservation table in PostgreSQL.
- **Trade-offs:** Adds one write on mutating operations. In exchange, guaranteed exactly-once mutations, safe browser retries, and protection against accidental double submissions.
- **What changes at 10x:** Offload short-lived idempotency tokens (10 minutes) to a distributed Redis cache, persisting only completed business results in PostgreSQL.

---

## 4. Transactional Outbox with `FOR UPDATE SKIP LOCKED` Instead of a Message Broker

- **Context:** State changes produce side effects (activity audit log, notifications, simulated emails, SLA monitors) that must never be lost if a process crashes.
- **Options Considered:**
  1. *Direct HTTP/dispatch calls inside API controllers:* Call email/notification services in the HTTP request thread. If the email succeeds but DB rolls back, phantom emails exist. If DB succeeds but network fails, the event is lost.
  2. *External Message Broker (RabbitMQ / Kafka / Redis Streams):* Requires running, securing, and maintaining external stateful infrastructure.
  3. *Transactional Outbox in PostgreSQL:* Events written in the same transaction as the item change. An asynchronous worker claims batches using `SELECT ... FOR UPDATE SKIP LOCKED`.
- **Decision:** Transactional outbox table with `SKIP LOCKED`, lease expirations, and idempotent handlers (`dedupe_key`).
- **Trade-offs:** Worker polls database every second when active. In exchange, 100% transactional consistency (zero dual-write bugs), no external infrastructure dependencies, and automatic crash recovery via worker leases.
- **What changes at 10x:** Scale horizontally with multiple worker instances or transition to Debezium CDC from PostgreSQL WAL.

---

## 5. Keyset Pagination & Specialized Multi-Type Indexing

- **Context:** Real operational lists grow to tens of thousands of items. Users search via titles, references (`OPS-1042`), and statuses.
- **Options Considered:**
  1. *`OFFSET / LIMIT` pagination:* Simple to write, but severely degrades as offset grows (scans and discards $O(N)$ rows).
  2. *Keyset cursor pagination with composite indexes:* Order by `(last_activity_at DESC, id DESC)`. Next page queries `WHERE (last_activity_at, id) < ($1, $2)`.
- **Decision:** Keyset pagination everywhere. Composite B-tree indexes for list filtering, GIN index on generated `tsvector` for keyword search, and `pg_trgm` trigram index for partial ref/title matching.
- **Trade-offs:** Cannot jump directly to arbitrary page numbers (e.g. "Page 45"), which is rarely needed in operational triage queues. In exchange, constant-time page loads ($O(1)$) regardless of queue depth.
- **What changes at 10x:** Partition `activity_log` by date range; offload search to OpenSearch.

---

## 6. What Was Intentionally Not Built

1. **Heavy ORM (Prisma / TypeORM):** Avoided to maintain full, uninhibited control over SQL queries, locks (`SKIP LOCKED`), advisory locks, and generated columns. Plain `pg` with parameterized queries delivers superior predictability and zero hidden query generation overhead.
2. **External Broker / Cache (Kafka / RabbitMQ / Redis):** Avoided to keep local setup trivial (`docker compose up` or local Node + Postgres) and keep hosted architecture far within free-tier resource limits.
3. **WebSockets Server:** Avoided in favor of Server-Sent Events (SSE). SSE operates over standard HTTP, traverses proxies effortlessly, and aligns with the one-way push pattern where clients refetch through the REST API.
4. **Client-Side Authorization Authority:** Avoided. UI hides unavailable actions for cleanliness, but the backend API remains the sole authorization authority, rejecting unauthorized actions with 403 or 404.

---

## 7. Hosting Architecture & Trade-Offs

1. **In-Process Worker on Render Free Tier:** Render's free tier supports a single web service. Running the outbox worker loop inside the Express API (`RUN_WORKER_IN_API=true`) allows full asynchronous outbox processing without requiring paid worker services.
2. **Render Cold Starts:** The free plan spins down after 15 minutes of idle time. The frontend handles this gracefully by detecting delayed responses (>3s), displaying an informative wake-up banner, and retrying automatically.
3. **Supabase Session-Mode Pooler (Port 5432):** We connect via port 5432 (session mode) rather than port 6543 (transaction mode) because advisory migration locks and `LISTEN/NOTIFY` require session-scoped connections.
