# Newtonite: Operations Under Pressure

A high-reliability, multi-tenant operational workflow platform built to handle concurrent work queues, strict approval separation of duties, and audit histories under high pressure.

---

## Submission Checklist

| Requirement | File / Directory | Description |
| :--- | :--- | :--- |
| **Source Code** | [/server](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server) & [/web](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web) | Independent Express API and React 19 frontend packages (no npm workspaces). |
| **Setup & Run Instructions** | [README.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/README.md) & [DEPLOY.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/DEPLOY.md) | One-command Docker run, zero-Docker local run, and step-by-step production deployment. |
| **Engineering Decisions** | [ENGINEERING_DECISIONS.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/ENGINEERING_DECISIONS.md) | Architectural trade-offs, SQL scoping, OCC, transactional outbox, and what was intentionally not built. |
| **Automated Tests** | [/server/tests](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/server/tests), [/web/tests](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/web/tests), [.github/workflows/ci.yml](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/.github/workflows/ci.yml) | 11 comprehensive suites testing concurrency, OCC, idempotency, state transitions, outbox, and RLS. |
| **Submission Checklist** | [SUBMISSION.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/SUBMISSION.md) & [docs/LIVE_REVIEW_CHEAT_SHEET.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/docs/LIVE_REVIEW_CHEAT_SHEET.md) | Technical defense cheat sheet with crisp answers, citations, and verified test proofs. |
| **Known Limitations** | [KNOWN_LIMITATIONS.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/KNOWN_LIMITATIONS.md) | Truthful evaluation of hosting cold-starts, worker topology, trust proxy hops, and in-memory rate limiting. |
| **Live Deployment URL** | *Not provided yet* | Deployable via [DEPLOY.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/DEPLOY.md) to Supabase + Render + Vercel. |

---

## AI Coding Disclosure

> In accordance with the challenge guidelines, AI coding assistants (Google Antigravity / Gemini) were utilized during the development of this repository for rapid scaffolding, test generation, and documentation drafting. Every line of code, SQL query, state transition, and configuration was reviewed, validated against real PostgreSQL 16 instances, and is fully understood by the author.

---

## Demo Credentials (Local & Seeded)

All demo accounts share the password: `Password123!`. 1-click fill buttons are provided on the login page (available in development or when `VITE_ENABLE_DEMO_LOGIN=true`):

| User | Email | Role Configuration | Demo Purpose |
| :--- | :--- | :--- | :--- |
| **Alice Admin** | `admin@newtonite.local` | **Org Administrator** | Organization-wide administration, dead-letter DLQ management, and roster edits. |
| **Priya Sharma** | `priya.lead@newtonite.local` | **Lead in Operations** / **Viewer in Engineering** | Cross-team permission enforcement, separation of duties, and lead sign-offs. |
| **Arjun Patel** | `arjun.lead@newtonite.local` | **Lead in Engineering** | Engineering lead reviews, triage, and multi-team collaboration. |
| **Elena Rostova** | `elena.member@newtonite.local` | **Member in Operations** | Work item claiming, in-progress updates, and approval submissions. |
| **Sarah Jenkins** | `sarah.viewer@newtonite.local` | **Viewer in Operations** | Read-only inspection; verifying that mutating operations return 403. |
| **Sofia Rossi** | `sofia.lead@newtonite.local` | **Lead in Payments** | Dedicated payments operations and isolation from non-member items (404). |

---

## Quickstart & Local Setup

### Option A: One-Command Docker Setup (Docker Path)

```bash
docker compose up --build
```
- **PostgreSQL 16:** Runs on `localhost:5432` with pre-created `newtonite` database.
- **API Server:** Accessible at `http://localhost:3000`.
- **Web Client:** Accessible at `http://localhost:5173`.
- **Worker:** Runs as a dedicated background container.

---

### Option B: Local Setup (No-Docker Path)

**Prerequisites:**
- Node.js 24 LTS (`.nvmrc` provided)
- PostgreSQL 16 running locally on port 5432

1. **Install Dependencies:**
   ```bash
   npm run setup
   ```
   *(Installs dependencies independently for `/server` and `/web`).*

2. **Run Migrations & Seed Data:**
   ```bash
   # Run advisory-locked database migrations (001-005)
   npm run migrate

   # Seed 1,000 items and 5,000 activity rows for local development
   npm run seed
   ```

3. **Start Development Servers:**
   ```bash
   npm run dev
   ```
   - API: `http://localhost:3000`
   - Frontend: `http://localhost:5173`

---

## Running Automated Tests

All tests run against a **real PostgreSQL 16 database** (no database mocks). Server tests strictly use a dedicated test database (`newtonite_test`) and will automatically abort if `DATABASE_URL` does not contain `test` to prevent touching production or demo data.

Before running `npm test`, you must run migrations and seed against the test database:

```bash
# 1. Run migrations against dedicated test database (newtonite_test)
npm --prefix server run migrate:test

# 2. Seed the baseline organizations, users, teams, and data
npm --prefix server run seed:test

# 3. Run both backend (Supertest + pg) and frontend (Vitest + RTL) tests
npm test

# Run code style and syntax linters
npm run lint
```

### Verified Test Suites (20 suites passing against real PostgreSQL 16 & Vitest):
1. `concurrency.test.ts`: Concurrent claims on one item -> exactly 1 winner (200), remaining losers (409 `ALREADY_CLAIMED`), 1 activity log entry.
2. `versioning.test.ts`: Missing `If-Match` returns 428; stale version returns 412 with server item; matching version increments `version`; strict Zod schema validation rejects mass-assignment (422).
3. `idempotency.test.ts`: Two-phase reservation; per-user scoping (`PRIMARY KEY (user_id, idempotency_key)`); canonical JSON key sorting; replayed requests return cached response; mismatched route/body returns 422; 5xx errors do not cache or delete committed effects.
4. `authorization.test.ts`: Other-team items return 404 (never 403); cross-team role scoping (Priya Lead in Ops vs Viewer in Eng).
5. `transitions.test.ts`: Comprehensive state machine transitions, resolution notes required, separation of duties in lead approvals.
6. `approve_reject.test.ts`: Proves approve/reject/reopen enforce: role, creator != approver, If-Match, idempotency, activity row, outbox event.
7. `outbox.test.ts`: Transactional outbox polling, lease expiration reclamation, exponential backoff, dead-letter transition, deduplication, and multi-worker concurrent partitioning via `FOR UPDATE SKIP LOCKED`.
8. `activity_log.test.ts`: Transaction rollback atomicity; immutability trigger blocks UPDATE, DELETE, and TRUNCATE.
9. `pagination.test.ts`: Keyset pagination has zero duplicates and zero skipped rows across concurrent inserts; search input safety with malformed tsquery syntax.
10. `rls.test.ts`: Verifies Row Level Security is enabled on every table in schema `public`.
11. `firebase_auth.test.ts`: Verifies unauthenticated login endpoint is eradicated (returns 404 `ROUTE_NOT_FOUND`).
12. `google_auth.test.ts`: Verifies Google OAuth token validation: signature, issuer, audience, expiry, `email_verified`, and no auto-linking on unverified emails.
13. `org_onboarding.test.ts` (backend): Atomic organization registration transaction, initial admin assignment, duplicate slug handling, and org member provisioning.
14. `sse.test.ts`: Dynamic membership re-check on every broadcast, unscoped events restricted to Org Admin, `Last-Event-ID` missed event resync, and client connection teardown on team removal.
15. `rate_limit.test.ts`: Login brute-force rate limit (429 with `Retry-After`) and mutating write rate limiter.
16. `frontend_contract.test.ts`: Contract tests hitting all frontend API endpoints with canonical JSON shapes.
17. `stale-edit.test.tsx` (frontend): Client stale-edit conflict panel displays diff and offers re-apply.
18. `optimistic-rollback.test.tsx` (frontend): Client handles 409 claim race gracefully and displays winner's name.
19. `idempotency-client.test.tsx` (frontend): Client generates 1 key per user intent, reuses on auto-retry, creates fresh key on new intent, and provides double-click protection.
20. `landing-auth.test.tsx` (frontend): Public landing page with dual entry buttons, absence of Google sign-in, and password toggle accessibility.

---

## Architecture & Technology Stack

- **Server:** Node.js 24 LTS, Express, Zod validation, `pg` (node-postgres), Pino structured logging.
- **Frontend:** React 19, Vite, TypeScript strict, TanStack Query, React Router.
- **Design System:** Calm, purposeful 13px operational aesthetic, self-hosted IBM Plex Sans + IBM Plex Mono fonts, CSS variables (light/dark theme).
- **Database:** PostgreSQL 16 with advisory-locked migrations, GIN full-text search (`tsvector`), trigram indexes (`pg_trgm`), and DB triggers.
- **Realtime:** Server-Sent Events (SSE) fan-out backed by a dedicated PostgreSQL `LISTEN/NOTIFY` client with polling fallback.
- **Deployment:** Vercel (static React + `/api/*` proxy rewrite), Render (Node.js API + in-process worker), Supabase (PostgreSQL 16 session pooler).

---

## Repository Structure

```
├── .github/
│   ├── dependabot.yml           # Automated dependency updates for npm and actions
│   └── workflows/
│       ├── ci.yml               # CI with PostgreSQL 16 container, lint, test, build, deploy
│       ├── keepalive.yml        # 10-minute readiness ping to prevent Render/Supabase sleep
│       └── seed-hosted.yml      # On-demand hosted database seeding (25k items)
├── docs/
│   ├── API.md                   # REST API documentation (/api/v1)
│   ├── architecture.md          # Architecture and Mermaid data-flow diagrams
│   ├── ASSUMPTIONS.md           # Architectural assumptions and constraints
│   ├── DEMO.md                  # 6-8 minute demonstration walkthrough script
│   ├── failure-modes.md         # Matrix of failure modes, behaviors, and proving tests
│   ├── performance.md           # Real EXPLAIN ANALYZE benchmark measurements
│   ├── scaling.md               # 10x and 100x architectural scaling roadmap
│   └── state-management.md      # State machine rules, OCC, and cache invalidation
├── server/                      # Independent Node.js backend package
│   ├── migrations/              # Numbered SQL migrations with advisory lock runner
│   ├── src/                     # Express app, policy engine, state machine, worker, SSE
│   └── tests/                   # Vitest + Supertest integration test suites
├── web/                         # Independent React Vite frontend package
│   ├── src/                     # React components, pages, design system, API client
│   ├── tests/                   # Vitest + RTL frontend tests
│   └── vercel.json              # Vercel proxy rewrite configuration
├── docker-compose.yml           # Local multi-container Docker development
├── render.yaml                  # Render Web Service Blueprint
├── ENGINEERING_DECISIONS.md     # Architectural choices, trade-offs, and omitted patterns
├── KNOWN_LIMITATIONS.md         # Transparent evaluation of constraints and boundaries
├── DEPLOY.md                    # Exact ordered deployment instructions
└── SUBMISSION.md                # Submission pack summary
```
