# Known Limitations

This document provides a truthful and honest accounting of architectural trade-offs, hosting constraints, and intentionally scoped boundaries in the current implementation.

---

## 1. Hosting & Infrastructure Constraints

### 1.1 Render Free-Tier Cold Starts
- **Limitation:** Render's free web service spins down after 15 minutes of idle time. The initial cold-start request takes 45–60 seconds while the container initializes.
- **Mitigation:** The frontend fetch layer detects requests taking longer than 3 seconds and displays a non-blocking informational banner (*"The server is waking up, this can take up to a minute..."*) and retries automatically.
- **Production Path:** Upgrade Render instance to the Starter plan ($7/mo) to eliminate sleeping.

### 1.2 In-Process Background Worker on Free Tier
- **Limitation:** On Render's free tier, background workers are not supported as separate services. The worker therefore runs inside the Express API process (`RUN_WORKER_IN_API=true`). When the API spins down due to inactivity, background outbox processing pauses until an incoming HTTP request wakes the instance.
- **Change Feed & Outbox Accumulation:** During extended sleep periods, `change_feed` rows and pending outbox events accumulate in PostgreSQL without active pruning. When an incoming request wakes the service, the worker resumes and drains the accumulated backlog and maintenance cleans up stale rows.
- **Integrity Guarantee:** Outbox rows persist transactionally in PostgreSQL. As soon as the service wakes, the worker resumes and drains the accumulated backlog without loss.

### 1.3 Supabase Free-Tier Inactivity Pause
- **Limitation:** Supabase automatically pauses free-tier database projects after 7 consecutive days of inactivity.
- **Mitigation:** A GitHub Actions workflow (`.github/workflows/keepalive.yml`) curls the `/api/v1/ready` readiness endpoint every 10 minutes.
- **Caveat:** GitHub Actions automatically disables scheduled workflows on repositories that have had no commit activity for 60 days.

### 1.4 SSE Streaming Through Vercel Proxy Rewrite
- **Limitation:** Server-Sent Events (SSE) proxied through Vercel's Edge rewrite (`web/vercel.json`) may be buffered or abruptly closed by edge proxies depending on geographic routing.
- **Mitigation:** The client implements an automatic fallback mechanism: after 2 consecutive connection failures, it activates 15-second polling and displays a visible "Polling" indicator in the top bar.

### 1.5 Database SSL Verification Fallback
- **Limitation:** When connecting to hosted Supabase PostgreSQL without providing the custom Supabase root certificate via `DB_SSL_CA`, the client uses TLS encryption with `rejectUnauthorized: false`.
- **Production Path:** Provide the official Supabase root CA certificate file in production and set `DB_SSL_CA=/etc/secrets/prod-ca.crt`.

### 1.6 Configurable Trust Proxy Hop Count & In-Memory Rate Limiting
- **Trust Proxy Configuration:** Express uses `TRUST_PROXY` (default: `2`). This models the standard production deployment topology: `Client -> Vercel Edge CDN / Proxy (Hop 1) -> Render Reverse Proxy (Hop 2) -> Node.js Express API`. Using an explicit numeric hop count ensures Express picks the genuine client IP from the end of the `X-Forwarded-For` chain while preventing client-forged upstream headers from spoofing client identity. If running behind a single proxy (e.g. local Nginx), set `TRUST_PROXY=1`.
- **In-Memory Rate Limiter:** The mutation rate limiter (`writeRateLimiter`, 120 writes/min) and authentication rate limiter (`loginRateLimitMap`, 5 attempts/15min) use in-process `Map` stores.
  - *Limitation 1 (Process Restarts):* When the Node.js container restarts or cold-starts on Render free-tier, in-memory rate limit counters reset.
  - *Limitation 2 (Horizontal Scaling):* When scaling across multiple API containers behind a load balancer, rate limits are tracked per-container rather than globally across the fleet.
  - *Production Path:* For multi-instance high-availability deployments, replace the in-memory maps with a shared distributed cache (Redis or Valkey via Upstash/ElastiCache) using sliding window rate limiting.

### 1.7 Render IPv6 Egress & Supabase Direct Host
- **Limitation:** Render free containers lack IPv6 egress routing. Attempting to connect to direct Supabase endpoints (`db.<project-ref>.supabase.co:5432`) causes `connect ENETUNREACH 2406:...` errors.
- **Solution & Requirement:** The database connection must use the IPv4 Supabase session pooler hostname (`aws-0-[region].pooler.supabase.com:5432`). Special characters in database passwords (such as `,` or `*`) must be URL percent-encoded (`%2C`, `%2A`).

### 1.8 Supabase Free-Tier Pooler Max Client Limits
- **Limitation:** Supabase's free-tier session pooler enforces a hard server-side concurrency cap of 15 simultaneous client connections (`pool_size: 15`). Exceeding this triggers `(EMAXCONNSESSION) max client connections reached`.
- **Mitigation:** The application configures `DB_POOL_MAX=10` by default. Under heavy client concurrency, requests queue cleanly in the Node.js `pg-pool` FIFO queue rather than crashing on rejected database connections.

---

## 2. Functional & Architecture Boundaries

### 2.1 Sequential Reference Number Gaps on Rollback
- **Limitation:** Per-team reference numbers (`short_ref`, e.g. `OPS-1042`) may exhibit numerical gaps if a creation transaction aborts or rolls back after incrementing the team counter row.
- **Rationale:** Strict zero-gap guarantees require table-level serialization locks that throttle concurrent writes. Gaps are standard in operational and enterprise systems (e.g. ERP order numbers, issue trackers).

### 2.2 Keyset Sorting Dimension
- **Limitation:** Keyset pagination is strictly ordered by `(last_activity_at DESC, id DESC)`. Sorting dynamically by arbitrary columns (e.g. title alphabetically or due date) without corresponding composite keyset indexes falls back to constrained result sets.

### 2.3 Email Delivery Configuration
- **Limitation:** External email delivery (SMTP / Resend / SendGrid) is not provisioned out of the box in free tier environments.
- **Mitigation:** When administrators create new user accounts, the server generates a cryptographically secure temporary password and displays it via a one-time reveal card with a copy-to-clipboard action for out-of-band delivery.

### 2.4 What Was Cut / Intentionally Deferred
- **SAML / OIDC Single Sign-On:** Authenticated via signed, secure `httpOnly` cookies with Argon2id password hashing. Corporate SAML/SSO was deferred to maintain simplicity.
- **Rich-Text WYSIWYG Editor:** Item descriptions and comments use clean plain text and markdown.
- **Multi-Region Database Replication:** Single primary database in Singapore region (paired with Render Singapore instance).

---

## 3. Fixed After Self-Review

Following comprehensive automated audits and review under real operational pressures, the following enhancements and hardening fixes were applied:

1. **Client Idempotency Key Retention Across Retries:** Added the `useIdempotencyKey()` hook to maintain stable client idempotency keys across manual user retries (e.g. network timeout or 503) and only regenerate fresh keys upon verified mutation success.
2. **Workflow State Machine Alignment for Claims:** Unified the claim action and state transition validator so claiming a `new` item moves it to `triaged` (with assignee set), preserving `transitions.ts` as the single source of truth.
3. **Search Index Acceleration via CTE UNION:** Refactored search candidate discovery from full-table sequential scan into an index-friendly `WITH hits AS (SELECT ... UNION ...)` common table expression with strict `%`, `_`, and `\` wildcard escaping, enabling GIN full-text and `pg_trgm` trigram index scans for both rare and common search terms.
4. **Outbox Maintenance Pruning:** Added automated cleanup of completed outbox events older than 14 days during periodic maintenance, while preserving all dead-letter records for administrator review.
5. **Input Validation Hardening & Separation of Duties:** Added strict UUID and enum validation across all API query parameters (returning 422 `VALIDATION_ERROR` rather than 500 errors), enforced separation of duties on item rejection (creators/assignees cannot reject), and added dashboard section totals with "+N more" and "View all" filters.
6. **Test Isolation & Safety Guard:** Isolated PostgreSQL-backed rate limit counters between test runs to eliminate cross-suite test leakage, and implemented a strict runtime safety guard that immediately aborts tests if `DATABASE_URL` does not point to a dedicated test database.
7. **Operational UI Polish:** Upgraded the work queue and attention interfaces with high-contrast dual color+text badges for status and priority, explicit overdue indicators for items past `due_at`, non-wrapping monospace references, left-aligned table headers, and `prefers-reduced-motion` compliance.
8. **Item Detail Crash Prevention:** Guarded activity timeline and tag collections against `undefined` array access, eliminating `Cannot read properties of undefined (reading 'length')` errors when rendering items.


