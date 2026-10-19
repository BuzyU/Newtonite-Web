-- 002_indexes_and_views.sql
-- High-efficiency indexes for queries, search, keyset pagination, and async worker

-- Multi-column composite index for team item listing with status/priority/activity ordering
CREATE INDEX IF NOT EXISTS idx_items_team_status_prio_activity
ON items(team_id, status, priority, last_activity_at DESC);

-- Partial index for open items assigned to specific users
CREATE INDEX IF NOT EXISTS idx_items_open_assignee
ON items(assignee_id, status, last_activity_at DESC)
WHERE status NOT IN ('resolved', 'closed') AND archived_at IS NULL;

-- Partial index for unassigned open items (urgent unassigned alerts)
CREATE INDEX IF NOT EXISTS idx_items_unassigned_open
ON items(team_id, priority, created_at DESC)
WHERE assignee_id IS NULL AND status NOT IN ('resolved', 'closed') AND archived_at IS NULL;

-- Full-text search GIN index on generated tsvector (title + description)
CREATE INDEX IF NOT EXISTS idx_items_search_vector
ON items USING gin(search_vector);

-- Trigram GIN indexes for ILIKE substring matching on title and short_ref
CREATE INDEX IF NOT EXISTS idx_items_title_trgm
ON items USING gin(title extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_items_short_ref_trgm
ON items USING gin(short_ref extensions.gin_trgm_ops);

-- Keyset pagination index on activity_log: (item_id, created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS idx_activity_log_item_created_id
ON activity_log(item_id, created_at DESC, id DESC);

-- Keyset pagination index on comments: (item_id, created_at ASC, id ASC)
CREATE INDEX IF NOT EXISTS idx_comments_item_created_id
ON comments(item_id, created_at ASC, id ASC);

-- Outbox worker polling index (FOR UPDATE SKIP LOCKED)
CREATE INDEX IF NOT EXISTS idx_outbox_events_poll
ON outbox_events(status, next_attempt_at, lease_timeout_at)
WHERE status IN ('pending', 'failed', 'processing');

-- User unread notifications index
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
ON notifications(user_id, is_read, created_at DESC);

-- Idempotency key lookup index
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_lookup
ON idempotency_keys(user_id, key);

-- SLA check index
CREATE INDEX IF NOT EXISTS idx_sla_checks_lookup
ON sla_checks(item_id, kind, window_label);
