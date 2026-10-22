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
- **Request Hash:** `requestHash = SHA256(userId + method + targetPath + body)`. Reusing the same key on a different route or with altered parameters is rejected with `422 IDEMPOTENCY_KEY_REUSE_MISMATCH`.
- **5xx Safety:** If an unhandled internal error occurs (status >= 500), the idempotency record is automatically deleted (`completeIdempotency`), allowing the client to safely retry rather than permanently caching a transient failure.
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
- **Multi-Worker Safety:** Verified via test `outbox.test.ts`. Multiple concurrent worker instances partition pending batches seamlessly without double-processing or lock waits. Expired leases left by crashed workers are reclaimed automatically.
- **Trade-offs:** Worker polls database every second when active. In exchange, 100% transactional consistency (zero dual-write bugs), no external infrastructure dependencies, and automatic crash recovery via worker leases.
- **What changes at 10x:** Scale horizontally with multiple worker instances or transition to Debezium CDC from PostgreSQL WAL.

---

## 5. Keyset Pagination & Specialized Multi-Type Indexing

- **Context:** Real operational lists grow to tens of thousands of items. Users search via titles, references (`OPS-1042`), and statuses.
- **Options Considered:**
  1. *`OFFSET / LIMIT` pagination:* Simple to write, but severely degrades as offset grows (scans and discards $O(N)$ rows).
  2. *Keyset cursor pagination with composite indexes:* Order by `(last_activity_at DESC, id DESC)`. Next page queries `WHERE (last_activity_at, id) < ($1, $2)`.
- **Decision:** Keyset pagination everywhere. Composite B-tree indexes for list filtering, GIN index on generated `tsvector` for keyword search, and `pg_trgm` trigram index for partial ref/title matching. Search uses `websearch_to_tsquery('english', $1)` to safely parse arbitrary user punctuation without throwing 500 errors.
- **Trade-offs:** Cannot jump directly to arbitrary page numbers (e.g. "Page 45"), which is rarely needed in operational triage queues. In exchange, constant-time page loads ($O(1)$) regardless of queue depth.
- **What changes at 10x:** Partition `activity_log` by date range; offload search to OpenSearch.

---

## 6. What Was Intentionally Not Built

1. **Heavy ORM (Prisma / TypeORM):** Avoided to maintain full, uninhibited control over SQL queries, locks (`SKIP LOCKED`), advisory locks, and generated columns. Plain `pg` with parameterized queries delivers superior predictability and zero hidden query generation overhead.
2. **External Broker / Cache (Kafka / RabbitMQ / Redis):** Avoided to keep local setup trivial (`docker compose up` or local Node + Postgres) and keep hosted architecture far within free-tier resource limits.
3. **WebSockets Server:** Avoided in favor of Server-Sent Events (SSE). SSE operates over standard HTTP, traverses proxies effortlessly, and aligns with the one-way push pattern where clients refetch through the REST API. Client-side resilience is reinforced with automatic fallback to polling when proxies buffer or terminate SSE streams.
4. **Client-Side Authorization Authority:** Avoided. UI hides unavailable actions for cleanliness, but the backend API remains the sole authorization authority, rejecting unauthorized actions with 403 or 404.

---

## 7. Organization Bootstrap & Atomic Tenant Creation

- **Context:** An organization onboarding workflow must safely provision a tenant workspace, its initial administrator, and its operational foundation without allowing privilege escalation or leaving dangling records on network/database failure.
- **Options Considered:**
  1. *Multi-request creation from frontend:* Frontend calls `createOrg`, then `createUser`, then `createTeams`, then `assignRoles`. If step 3 fails, an orphaned organization and user exist without default teams.
  2. *Single database transaction (`BEGIN ... COMMIT`):* The backend endpoint `POST /api/v1/auth/register-org` executes all 4 steps inside a single database transaction.
- **Decision:** Atomic server-side creation within a single transaction.
  - Generates or validates unique organization slug.
  - Hashes admin password with Argon2id.
  - Inserts organization and administrator record with `is_org_admin = TRUE`.
  - Automatically seeds default operational teams (`operations`, `engineering`, `payments`).
  - Binds the administrator to all default teams with `admin` role.
  - Automatically establishes a 30-day persistent session.
  - If any step throws an error, the entire transaction rolls back cleanly.
- **Security Safeguard:** A public caller can only bootstrap a *new* organization; they cannot grant themselves administrator privileges inside an existing organization.

---

## 8. Role Separation: Organization Administrator vs. Team-Level Roles

- **Context:** Large operational organizations require clear boundaries between platform administration (inviting employees, provisioning credentials, auditing rosters) and operational triage (creating items, executing workflow transitions, approving releases).
- **Decision:** Explicit architectural separation between organization-level and team-level roles:
  - **Organization Administrator (`is_org_admin: true`):** Platform manager. Can access `/admin` (Admin Console), provision user credentials, manage organization-wide rosters, and view dead-letter outbox events.
  - **Team Roles (`viewer`, `member`, `lead`, `admin`):** Scoped to specific team work items:
    - *Viewer:* Read-only access to team queue. Cannot mutate or claim items.
    - *Member:* Can create, claim, edit, transition, and comment on team items. Cannot approve items.
    - *Lead:* Can review and execute approval transitions (`approve`, `reject`). Enforces separation of duties (cannot approve items they created or currently hold).
    - *Admin:* Team-level configuration authority.
- **Enforcement:** Enforced at the SQL query level and Express middleware (`requireOrgAdmin`), never by merely hiding frontend UI buttons.

---

## 9. Session Security & Cookie Lifecycle

- **Context:** Authentication must survive page reloads and browser restarts without vulnerable token storage in `localStorage` or `sessionStorage`.
- **Decision:** Server-managed sessions backed by PostgreSQL `sessions` table and signed `httpOnly` cookies:
  - **Cookie Flags:** `httpOnly: true`, `SameSite: 'lax'`, `path: '/'`, `secure: true` in production over HTTPS.
  - **Session Duration:** 30 days (`maxAge: 30 * 24 * 3600 * 1000`) for "Remember Me", 12 hours for standard session.
  - **CSRF Defense:** State-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`) require the custom header `X-Requested-With: XMLHttpRequest` and undergo strict origin checking.
  - **Authentication & Optional Google OAuth:** Primary authentication relies on secure email + Argon2id password verification with server-managed sessions. Google OAuth (`/api/v1/auth/google`) is retained as an optional identity provider controlled by the `GOOGLE_LOGIN_ENABLED` environment variable (disabled by default in production and covered by automated tests in `google_auth.test.ts`), preventing external service dependencies while providing enterprise flexibility.
  - **Session Invalidation:** Logout revokes the server session in PostgreSQL, clears the browser cookie, and purges all user-scoped query caches.

---

## 10. Visual Design Direction: "Quiet Operations"

- **Context:** Operational staff triage incidents and approvals under intense cognitive load. Flashy marketing aesthetics, animated blobs, glowing purple/cyan AI gradients, and decorative emojis increase fatigue and degrade usability.
- **Decision:** "Quiet Operations" design system:
  - **Default Theme:** Light theme by default for new visitors. Dark theme available via explicit toggle.
  - **Color Palette:** Pure white and soft zinc/slate surfaces (`#FFFFFF`, `#F8FAFC`, `#F1F5F9`), deep charcoal high-contrast text (`#0F172A`), muted secondary labels (`#64748B`), and a single restrained slate-blue accent (`#2563EB`). Zero AI neon glowing effects.
  - **Typography:** IBM Plex Sans for editorial clarity and IBM Plex Mono for technical identifiers (`OPS-1042`, ETags, timestamps).
  - **Iconography:** Clean, accessible SVG vector icons and text labels. Zero emojis in navigation.



