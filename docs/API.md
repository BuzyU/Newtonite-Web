# Newtonite REST API Reference (`/api/v1`)

All endpoints use JSON envelopes and are relative to `/api/v1`.

---

## 1. Standard Request Headers

| Header | Description | Required On |
| :--- | :--- | :--- |
| `X-Requested-With` | Value `XMLHttpRequest` (CSRF defense for cookie auth) | All mutating methods (`POST`, `PATCH`, `PUT`, `DELETE`) |
| `Idempotency-Key` | Unique UUID or client token per user action | Recommended on all mutating requests |
| `If-Match` | ETag string (e.g. `"4"`) representing current item `version` | All `PATCH /api/v1/items/:id` updates |

---

## 2. Standard Error Envelope

All non-2xx responses return a consistent JSON envelope:

```json
{
  "error": {
    "code": "STALE_VERSION",
    "message": "Item was updated by another user. Version conflict.",
    "details": {
      "current_item": { "id": "...", "version": 3, "title": "..." }
    },
    "requestId": "req-1718000000-abc1234"
  }
}
```

### HTTP Status Code Mappings
- **200 OK:** Request succeeded.
- **201 Created:** Resource created.
- **401 UNAUTHENTICATED:** Missing or expired session cookie.
- **403 FORBIDDEN:** Authenticated, but user role lacks permission for this action on the visible resource.
- **404 NOT_FOUND:** Resource does not exist or caller does not belong to the resource's team.
- **409 CONFLICT:**
  - `ALREADY_CLAIMED`: Item was claimed by another user.
  - `INVALID_TRANSITION`: State transition violates business rules.
  - `REQUEST_IN_PROGRESS`: A request with this `Idempotency-Key` is currently executing.
- **412 PRECONDITION_FAILED:** `STALE_VERSION` – provided `If-Match` does not match current server version.
- **422 UNPROCESSABLE_ENTITY:** Zod validation failure or idempotency payload mismatch.
- **428 PRECONDITION_REQUIRED:** Mutating update omitted required `If-Match` header.
- **429 TOO_MANY_REQUESTS:** Rate limit exceeded.
- **503 SERVICE_UNAVAILABLE:** Database connection timeout or health failure.

---

## 3. Endpoints

### System & Health
- `GET /health` — Liveness check (does not touch database). Returns `200 { status: "ok" }`.
- `GET /ready` — Readiness check (executes `SELECT 1` on database). Returns `200 { status: "ready" }` or `503`.

### Authentication & Identity
- `POST /auth/login` — Sign in with `{ email, password }`. Sets signed `httpOnly` cookie.
- `POST /auth/logout` — Invalidate session and clear cookie.
- `GET /auth/me` — Return authenticated user profile and team memberships.

### Work Items
- `GET /items` — Keyset paginated work queue.
  - Query parameters: `q`, `status`, `priority`, `type`, `team_id`, `assignee` (`me` / `unassigned` / UUID), `tag`, `cursor`, `limit` (max 100).
- `POST /items` — Create a work item. Requires `Idempotency-Key`.
- `GET /items/:id` — Full work item details including computed "next" status, recent activity, and user permissions.
- `PATCH /items/:id` — Optimistic update (title, description, priority, tags). Requires `If-Match: "<version>"`.
- `POST /items/:id/claim` — Atomic claim. Single-winner conditional update (`assignee_id IS NULL`). Loser gets 409 `ALREADY_CLAIMED`.
- `POST /items/:id/transition` — Execute workflow state transition (`status`, optional `note`).
- `POST /items/:id/approve` — Lead approval transition to `resolved` (requires `note`). Separation of duties enforced.
- `POST /items/:id/reject` — Lead rejection transition back to `in_progress` (requires `note`).
- `POST /items/:id/reopen` — Reopen a resolved or closed item to `triaged` (requires `note`).

### Collaboration & History
- `GET /items/:id/activity` — Keyset paginated activity timeline (`cursor`, `limit`).
- `POST /items/:id/comments` — Post comment on an item (`content` with `@mentions`).

### Attention Home
- `GET /attention` — Aggregated attention dashboard partitioned into:
  - `awaiting_approval`: Items pending caller's lead review.
  - `mine_due_soon`: Items assigned to caller due in <24h or overdue.
  - `urgent_unassigned`: Urgent unassigned items across caller's teams.
  - `mentions`: Comments mentioning the caller.
  - `gone_quiet`: Open items with zero activity for 3+ days.

### Teams & Admin
- `GET /teams` — List teams caller belongs to (or all teams if org admin).
- `GET /teams/:id` — Team details and member roster.
- `GET /admin/dead-letters` — List outbox events parked in `dead_letter` status (admin only).
- `POST /admin/dead-letters/:id/retry` — Reset dead-letter event to `pending` for reprocessing.

### Real-Time Streaming
- `GET /events` — Server-Sent Events stream. Bound to user's team memberships. Emits `connected`, `item_update`, `resync`. Sends heartbeat comments every 20 seconds.
