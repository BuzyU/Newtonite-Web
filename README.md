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
| **Known Limitations** | [KNOWN_LIMITATIONS.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/KNOWN_LIMITATIONS.md) | Truthful evaluation of hosting cold-starts, worker topology, and sequential numbering trade-offs. |
| **Live Deployment URL** | *Not provided yet* | Deployable via [DEPLOY.md](file:///c:/Users/umerz/OneDrive/Desktop/Newtonion/Web/DEPLOY.md) to Supabase + Render + Vercel. |

---

## AI Coding Disclosure

> In accordance with the challenge guidelines, AI coding assistants (Google Antigravity / Gemini) were utilized during the development of this repository for rapid scaffolding, test generation, and documentation drafting. Every line of code, SQL query, state transition, and configuration was reviewed, validated against real PostgreSQL 16 instances, and is fully understood by the author.

---

## Demo Credentials (Local & Seeded)

All demo accounts share the password: `Password123!`. 1-click fill buttons are provided on the login page:

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
   # Run advisory-locked database migrations
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

All tests run against a **real PostgreSQL 16 database** (no database mocks).

```bash
# Run both backend (Supertest + pg) and frontend (RTL) tests
npm test

# Run code style and syntax linters
npm run lint
```

### Verified Test Suites:
1. `concurrency.test.ts`: 50 concurrent claims on one item -> exactly 1 winner (200), 49 losers (409 `ALREADY_CLAIMED`).
2. `versioning.test.ts`: Missing `If-Match` returns 428; stale version returns 412 with server item; matching version increments `version`.
3. `idempotency.test.ts`: Idempotent replays return cached responses; concurrent identical requests handle gracefully; mismatched payloads return 422.
4. `authorization.test.ts`: Other-team items return 404 (never 403); cross-team role scoping (Priya Lead in Ops vs Viewer in Eng).
5. `transitions.test.ts`: Comprehensive state machine transitions, resolution notes required, separation of duties in lead approvals.
6. `outbox.test.ts`: Transactional outbox polling, lease expiration reclamation, exponential backoff, dead-letter transition, deduplication.
7. `activity_log.test.ts`: Transaction rollback atomicity; immutability trigger blocks UPDATE, DELETE, and TRUNCATE.
8. `pagination.test.ts`: Keyset pagination has zero duplicates and zero skipped rows across concurrent inserts.
9. `rls.test.ts`: Verifies Row Level Security is enabled on every table in schema `public`.
10. `stale-edit.test.tsx`: Client stale-edit conflict panel displays diff and offers re-apply.
11. `optimistic-rollback.test.tsx`: Client handles 409 claim race gracefully and displays winner's name.

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
