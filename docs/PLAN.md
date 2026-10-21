# PLAN: Newtonite Phases 3 to 8

_Created 2026-10-22. Living document. Only real results go in the verification log._

## Plan vs Reality (fill in at the end)
_Not yet written._

## 1. Goal and scope
Done means Section 9 of the master brief: org sign-up wizard to `/admin` signed in; persistent sessions
(remember-me, restart-safe); admin user lifecycle with one-time credentials and audit log; no
Google/Supabase/Firebase auth anywhere; proven cross-org and non-admin isolation; Quiet Ledger theme with
AA contrast and 360px support; all backend, frontend and Playwright tests green with real output;
deployed Vercel-only (static + Express function, Supabase as plain Postgres) with a passing smoke test;
screenshots and axe scan; clean repo; demo seed (~25k items); review cheat sheet.

## 2. Assumptions (Q1-Q14 defaults, no answers received yet)
Q1 email+password, globally unique email. Q2 one org per user. Q3 full multi-tenancy by `org_id`, cross-org = 404.
Q4 no email verification/reset. Q5 keep four roles. Q6 existing seed becomes dev-only demo org.
Q7 remember = 30d sliding; otherwise session cookie, 12h idle / 24h absolute. Q8 deactivate only.
Q9 skip CSV. Q10 IP rate limit on org creation + reserved slugs. Q11 Vercel only. Q12 Supabase as plain Postgres.
Q13 Hobby plan: one daily cron + `waitUntil` + Supabase pg_cron/pg_net or GitHub Actions for the tick.
Q14 polling changes feed every 5s; SSE only behind a flag if tests stay green.

## 3. Findings that drive the plan (files actually opened/grepped, 2026-10-22)
- Auth: `server/src/auth.ts` has cookie sessions (httpOnly, SameSite=Lax, ~L53-70), CSRF via `X-Requested-With`
  (~L73), an in-memory login limiter `loginRateLimitMap` (L24, per-process: breaks on serverless), a Google/Supabase
  path with `UNVERIFIED_EMAIL` (L470). Memberships loaded into a `Map` per request (L154).
- No `organizations` table and no `org_id` anywhere in migrations 001-005 (grep). Tenancy is a greenfield migration.
- Migrations on disk: `001_initial_schema`, `002_indexes_and_views`, `003_triggers_and_immutability`,
  `004_rls_and_permissions`, `005_google_auth` (listed with `list_dir`). RLS is enabled on all tables with no policies.
- Realtime: `server/src/sse.ts` holds a module-level `sseClients` Map and a dedicated LISTEN client; `server/src/index.ts`
  starts it and calls `listen`. Both are incompatible with Vercel Functions (needs polling feed + `createApp()` entry).
- Worker: `server/src/worker.ts` is a polling loop process; needs `drainOutbox` refactor for tick endpoint.
- Idempotency: `idempotency_keys` has `UNIQUE (user_id, key)` (migration 001 L127). Scoped per user, not yet per org.
- Separation of duties exists in `server/src/policy.ts` (L49-56, L130-134): reporter and assignee cannot approve.
- Seed: `server/src/seed.ts` uses `crypto.randomBytes(16)` for random passwords and gates production on
  `ALLOW_PROD_SEED`. No `seed:demo` script exists yet.
- Repo state: branch `main`, 49 uncommitted/untracked paths (all Phase 2/3 work is NOT committed). Remote:
  `github.com/BuzyU/Newtonite-Web`. Tracked files matching junk patterns: `docs/AUDIT.md` (scratch audit),
  `.env.example` files (fine). No tracked `.env`/logs seen in the first scan; full secrets scan still TODO.
- Tests on disk (server): activity_log, approve_reject, authorization, concurrency, firebase_auth, frontend_contract,
  google_auth, idempotency, outbox, pagination, rate_limit, rls, sse, transitions, versioning. There is NO
  `occ.test.ts`; OCC is covered by `versioning.test.ts`.

### Corrections to my previous (Phase 3 draft) report and docs/LIVE_REVIEW_CHEAT_SHEET.md
These were written without opening every cited file. To fix under P3-00:
1. Cheat sheet cites `server/tests/occ.test.ts`: does not exist. Should be `versioning.test.ts`.
2. Cheat sheet/README say idempotency is `PRIMARY KEY (user_id, idempotency_key)`: actual is `UNIQUE (user_id, key)`.
3. Docs say seed passwords are 24 chars from `randomBytes(18)`: actual is `randomBytes(16).toString('base64url')` (22 chars).
4. Cheat sheet says `403 UNVERIFIED_EMAIL`, `CREATOR_CANNOT_APPROVE`, `dropUserSseClients`, `canonicalJsonStringify`,
   "button disables immediately" and "5xx deletes only if status != completed": each must be re-verified by opening
   the file before the claim stays. Unverified claims will be removed, not softened.
5. Cheat sheet says `DB_POOL_MAX=50` is set in the test via `process.env`: re-open `concurrency.test.ts` to confirm.
6. Cheat sheet says frontend demo chips are hidden in production builds: not verified; `LoginPage.tsx` must be read.
7. Phase 3 report said "all 14 requirements done"; items 11-12 evidence is the Playwright script run + screenshots only.
   I did not run an axe scan or measure contrast ratios, so "WCAG AA exceeded 4.5:1" was unverified. P6 will measure.
8. Several items.ts changes during E2E debugging (comments in GET /items/:id, `current_assignee` alias, camelCase create
   payload) were bug fixes found by the browser run but have no failing-test-first evidence yet. Add tests (P3-12).

## 4. Task checklist
Sizes S/M/L. Status values: TODO, IN PROGRESS, BLOCKED, DONE, DROPPED. One IN PROGRESS at a time.

### Phase 3: verify and finish Phase 2
- [ ] P3-00 (S) Fix doc corrections above; verify each cited claim by opening files. Files: docs/LIVE_REVIEW_CHEAT_SHEET.md, README, ENGINEERING_DECISIONS. Proof: grep of every cited path exists. Status: TODO
- [ ] P3-01 (M) Create branch, commit Phase 2/3 work in concern-sized commits, push, check CI; triage 20 PRs. Deps: none. Status: TODO
- [ ] P3-02 (S) Migrations apply twice and from empty DB; fix names in docs. Test: new `migrations.test.ts`. Status: TODO
- [ ] P3-03 (M) CONC-02 client keys: re-read `web/src/api.ts`, confirm one key per intent; strengthen web tests (double-click test currently mocks `api.post` and asserts nothing about a real button; make it render the component). Status: TODO
- [ ] P3-04 (S) Concurrency test pool 50: confirm in file; honest README wording. Status: TODO
- [ ] P3-05 (M) Approve/reject/reopen share one code path with /transition; tests exist in approve_reject.test.ts, review for gaps. Status: TODO
- [ ] P3-06 (M) SSE items (a)-(e): re-verify membership recheck, heartbeat 15-25s, Last-Event-ID; document events without team_id. Status: TODO
- [ ] P3-07 (M) Idempotency: org scoping later; verify effect+key same tx; TTL cleanup job. Status: TODO
- [ ] P3-08 (S) `TRUST_PROXY_HOPS` env rename (currently `TRUST_PROXY`); measure on preview. Dep: P6B. Status: TODO
- [ ] P3-09 (S) Multi-worker test asserts total==N, no duplicates (verify actual assertions). Status: TODO
- [ ] P3-10 (S) Single response shape for attention/deadLetters; update docs/API.md. Status: TODO
- [ ] P3-11 (S) RLS honesty doc + test as non-owner role proving deny-all. Status: TODO
- [ ] P3-12 (S) Failing-test-first coverage for item-detail comments, claim 409 payload, create payload shape. Status: TODO

### Hygiene pass 1 (6C)
- [ ] H1-01 (M) Backup tag/branch; secrets scan (gitleaks/log greps), report names only; rotate if needed. Status: TODO
- [ ] H1-02 (S) Remove tracked junk (docs/AUDIT.md if scratch), tighten .gitignore/.gitattributes. Status: TODO

### Phase 4: auth, sessions, tenancy (security-critical, do first after P3)
- [ ] P4-01 (M) Remove Google/Supabase/Firebase code, deps, env, docs; 404 tests. Status: TODO
- [ ] P4-02 (M) Root-cause login redirect/"forgets me" with real Set-Cookie evidence; AuthContext bootstrap fix. Status: TODO
- [ ] P4-03 (L) Sessions table (hashed token), argon2id, password policy, remember/idle/absolute, logout-all, change-password, must-change gate. Deps: P4-01. Status: TODO
- [ ] P4-04 (L) Migration 006: organizations + org_id everywhere + backfill + indexes; per-org refs. Status: TODO
- [ ] P4-05 (L) Centralized org scoping in policy/query helpers; cross-org IDOR matrix tests. Dep: P4-04. Status: TODO
- [ ] P4-06 (M) `POST /orgs` atomic sign-up, slug availability, reserved slugs, rate limit. Deps: P4-03, P4-04. Status: TODO
- [ ] P4-07 (S) Pino redaction for secrets; CSRF Origin check. Status: TODO

### Phase 5: product flows
- [ ] P5-01 (M) Landing; P5-02 (L) wizard; P5-03 (M) login + returnTo + forced password change screen;
  P5-04 (L) admin dashboard (overview, users, create-user + one-time credentials, teams, settings, audit log, DLQ);
  P5-05 (M) queue filters in URL, keyset pagination; P5-06 (S) item type/why/next-step audit; P5-07 (M) Inbox. Status: TODO

### Phase 6 / 6A: theme and screens
- [ ] P6-01 (M) Tokens, contrast table (measured with a script), theme before first paint.
  P6-02 (L) component set (consider Radix); P6-03 (M) screen specs 6A; P6-04 (M) responsive 360; P6-05 (S) axe scan; P6-06 (M) screenshots at 1440/768/360 light+dark. Status: TODO

### Phase 6B: Vercel-only
- [ ] P6B-01 (M) `createApp()` factory + `api/index.ts` + vercel.json (rewrites, headers, CSP)
  P6B-02 (M) pg pool for transaction pooler; DATABASE_URL vs DATABASE_URL_DIRECT; migrate script
  P6B-03 (L) `change_feed` table + `/changes` + `useChangesFeed`; decide SSE keep/delete
  P6B-04 (L) `drainOutbox` + tick endpoint + CRON_SECRET + waitUntil + maintenance job
  P6B-05 (M) Postgres-backed rate limiter; audit module-level state
  P6B-06 (S) env validation with Zod; `.env.example`
  P6B-07 (S) delete render.yaml, keepalive.yml; rework seed-hosted.yml
  P6B-08 (M) smoke script; P6B-09 (M) DEPLOY.md rewrite. Status: TODO. BLOCKED on my having Vercel and Supabase accounts: I can write and test everything locally, but cannot deploy or claim a live URL without your credentials.

### Hygiene pass 2 / demo / tests / docs
- [ ] H2-01 dead code (knip/depcheck), docs sprawl, history, CLEANUP_REPORT.md
- [ ] D-01 `seed:demo` (~25k items, <60s, staged scenarios) + docs/DEMO.md
- [ ] T7-01 Playwright suite (6 scenarios) + CI gates; T7-02 frontend test additions
- [ ] P8-01 README, ENGINEERING_DECISIONS, KNOWN_LIMITATIONS, API, architecture, failure-modes, scaling, performance, design-system, ASSUMPTIONS
- [ ] P8-02 REVIEW_CHEATSHEET.md maintained per feature (not at the end)

## 5. Order of work and critical path
P3 (verify, commit) -> H1 -> P6B-01/05/06 early (createApp, Postgres limiter, env) -> P4 (sessions, tenancy) ->
P4 tests -> D-01 seed (after tenancy) -> P5 flows -> P6 theme -> P6B-03/04 (feed, tick) -> T7 -> H2 -> P8.
Critical path: P4-04 (org_id migration) blocks P4-05, P4-06, P5-04, D-01, and the changes feed scoping.

## 6. Risks and open questions
| Risk | Owner | Mitigation |
|---|---|---|
| Scope is very large; cannot all be finished and verified in one session | me | Work phase by phase; scope-cut rule 6D.3; report honestly what is DONE |
| Cannot deploy to Vercel/Supabase without your accounts/keys | you | I build and test locally; you provide project access or run DEPLOY.md; no live URL claimed until smoke test passes |
| 49 uncommitted files on `main`; history rewrite needs approval | you | Branch + backup tag before anything; no force push without approval |
| Postgres-local instance is my own `pgsql` install under `~/.local`, not Docker | me | Tests run against real PG16; CI uses PG16 container |
| org_id migration vs activity_log immutability trigger | me | Test migration on seeded DB; use trigger-safe pattern |
| Possible secrets in history unknown | me | H1-01 scan first |

## 7. Verification log
| Date/Time | Task | Command | Result | Notes |
|---|---|---|---|---|
| 2026-10-22 03:25 | (Phase 3 carry-over) | `npm test` in server | pass | 15 files / 58 tests |
| 2026-10-22 03:25 | (Phase 3 carry-over) | `npm test` in web | pass | 3 files / 4 tests |
| 2026-10-22 03:28 | (Phase 3 carry-over) | `npm run build` server, then web | pass (web after 2 TS fixes) | |
| 2026-10-22 03:25 | (Phase 3 carry-over) | `node scripts/e2e-run.js` | pass after fixes | script, not a CI Playwright test; loser banner text verified via page HTML |
| 2026-10-22 03:34 | P3-00 | git grep / list_dir of claims | done | findings in section 3 |

## 8. Change log / decisions
- 2026-10-22: Plan created. Added P3-00 and P3-12 after finding unverified claims and untested bug fixes.

## 9. Parking lot
CSV import, CAPTCHA on sign-up, multi-org membership, email delivery, MFA.
