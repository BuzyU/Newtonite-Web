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

---

## 2. Functional & Architecture Boundaries

### 2.1 Sequential Reference Number Gaps on Rollback
- **Limitation:** Per-team reference numbers (`short_ref`, e.g. `OPS-1042`) may exhibit numerical gaps if a creation transaction aborts or rolls back after incrementing the team counter row.
- **Rationale:** Strict zero-gap guarantees require table-level serialization locks that throttle concurrent writes. Gaps are standard in operational and enterprise systems (e.g. ERP order numbers, issue trackers).

### 2.2 Keyset Sorting Dimension
- **Limitation:** Keyset pagination is strictly ordered by `(last_activity_at DESC, id DESC)`. Sorting dynamically by arbitrary columns (e.g. title alphabetically or due date) without corresponding composite keyset indexes falls back to constrained result sets.

### 2.3 What Was Cut / Intentionally Deferred
- **SAML / OIDC Single Sign-On:** Authenticated via signed, secure `httpOnly` cookies with Argon2id password hashing. Corporate SAML/SSO was deferred to maintain simplicity.
- **Rich-Text WYSIWYG Editor:** Item descriptions and comments use clean plain text and markdown.
- **Multi-Region Database Replication:** Single primary database in Singapore region (paired with Render Singapore instance).
