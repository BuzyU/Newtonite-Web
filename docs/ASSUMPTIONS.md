# Architectural Assumptions

This document records the foundational assumptions and design constraints adopted in building the Newtonite platform.

---

### 1. Per-Team Reference Counters & Numbering Gaps
- **Assumption:** Gaps in `short_ref` numbering (e.g. `OPS-1001` followed by `OPS-1003` when `OPS-1002` rolls back) are acceptable and standard.
- **Rationale:** Strict zero-gap sequential counters require table-wide serial execution locks that bottleneck transactional throughput under concurrent load. Incrementing a per-team counter row (`UPDATE teams SET last_item_number = last_item_number + 1 RETURNING last_item_number`) inside the item creation transaction provides high concurrency while isolating teams from one another.

### 2. Authorization Scoping & 404 vs 403
- **Assumption:** Accessing an item or team that the caller does not belong to must return `404 NOT FOUND` rather than `403 FORBIDDEN`.
- **Rationale:** Returning `403` reveals that a resource exists with a given ID or reference, enabling enumeration and metadata probing across tenant boundaries. Returning `404` completely conceals non-member data. `403 FORBIDDEN` is strictly reserved for visible resources where the caller lacks permission for a specific mutation (e.g. a Viewer attempting to change item priority).

### 3. Database Connection Pooling & Port Modes
- **Assumption:** Connection strings must connect to PostgreSQL 16 or Supabase via the **Session-mode pooler (port 5432)** or direct connection, never transaction-mode poolers (port 6543).
- **Rationale:** Transaction-mode poolers break session-scoped features, specifically PostgreSQL advisory locks (`pg_advisory_lock` used by migration runners) and asynchronous messaging (`LISTEN` / `NOTIFY` used by real-time SSE fan-out).

### 4. Idempotency Key Expiration & Replay Window
- **Assumption:** Idempotency keys expire after 24 hours.
- **Rationale:** 24 hours covers all standard browser and client network retries. In-progress executions that crash without completing are automatically expired after 5 minutes so subsequent client retries are not permanently locked out.

### 5. Separation of Duties in Approval Workflows
- **Assumption:** A work item that requires lead approval must be approved by a user who is a team Lead and is **neither the original reporter nor the current assignee**.
- **Rationale:** Prevents self-approval loopholes in critical operational environments (e.g. compliance requests, payment investigations). The seed data provisions at least two Leads per team (e.g., Priya Patel and Elena Rostova) so this workflow is demoable and verifiable.

### 6. Background Worker In-Process Execution on Free Tier
- **Assumption:** On Render's free tier, background tasks run inside the Node.js Express process (`RUN_WORKER_IN_API=true`), whereas in local Docker Compose or multi-container deployments, the worker runs as an independent daemon.
- **Rationale:** Render's free tier provides a single Web Service with no background worker support. Running the outbox polling loop in-process maintains transactional outbox guarantees without incurring infrastructure costs.

### 7. Supabase Public Schema Protection via RLS
- **Assumption:** Row Level Security (RLS) is enabled on every table in schema `public` with privileges revoked from `anon` and `authenticated` roles.
- **Rationale:** Supabase exposes all public tables through its auto-generated PostgREST HTTP endpoint using the anonymous publishable key. Enabling RLS without permissive policies prevents unauthenticated external queries from bypassing the application's Express API.

### 8. Organization Bootstrap & Administrator Assignment
- **Assumption:** The user who registers a new organization through `POST /api/v1/auth/register-org` becomes its initial organization administrator (`is_org_admin = TRUE`).
- **Rationale:** This is an atomic bootstrap rule executed solely within a trusted database transaction on the server. Clients cannot manufacture administrator privileges by sending `role: "admin"` or `is_org_admin: true` in any request.

### 9. "Quiet Operations" Design Direction & Default Light Theme
- **Assumption:** The platform defaults to a crisp, high-legibility Light theme for fresh browser sessions without stored preferences (`localStorage['newtonite_theme']`).
- **Rationale:** Enterprise operational workflows require dense, reliable readability under diverse lighting conditions rather than dark-mode novelty. The design system explicitly eliminates AI-aesthetic glowing gradients, neon accents, floating blobs, and navigation emojis in favor of restrained neutral surfaces, slate blue accents, and accessible contrast.

### 10. Session Cookie Persistence & Remember Me Policy
- **Assumption:** Authentication uses signed, HTTP-only session cookies with explicit `maxAge`.
- **Rationale:** When "Remember me" is checked, the server issues a 30-day persistent cookie (`maxAge: 30 * 86400 * 1000`). When unchecked, a 12-hour working-session cookie is issued. Both employ `SameSite: 'lax'`, `path: '/'`, and `secure: true` in production.

### 11. Employee Account Provisioning via Administrator Setup
- **Assumption:** Without an external transactional email provider (such as Resend or SendGrid), employee onboarding is handled via an administrator-mediated temporary credential flow.
- **Rationale:** Rather than fabricating fake email delivery, the administrator provisions the account with designated teams and roles, receives a cryptographically generated temporary password via a one-time copy card, and securely delivers it to the employee out-of-band.

