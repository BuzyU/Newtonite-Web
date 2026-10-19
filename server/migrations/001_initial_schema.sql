-- 001_initial_schema.sql
-- Core schemas, extensions, and tables

-- Ensure extensions schema exists and enable pg_trgm within it
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Teams
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(50) NOT NULL UNIQUE,
    prefix VARCHAR(10) NOT NULL UNIQUE,
    item_counter BIGINT NOT NULL DEFAULT 1000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_org_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Team Memberships (per-team roles: viewer, member, lead, admin)
CREATE TABLE IF NOT EXISTS team_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('viewer', 'member', 'lead', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_team_membership UNIQUE(team_id, user_id)
);

-- Work Items
CREATE TABLE IF NOT EXISTS items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_ref VARCHAR(32) NOT NULL UNIQUE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    type VARCHAR(32) NOT NULL CHECK (type IN (
        'customer_issue',
        'engineering_problem',
        'payment_investigation',
        'production_incident',
        'compliance_request',
        'operational_task'
    )),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'new' CHECK (status IN (
        'new',
        'triaged',
        'in_progress',
        'blocked',
        'awaiting_approval',
        'resolved',
        'closed'
    )),
    priority VARCHAR(16) NOT NULL DEFAULT 'medium' CHECK (priority IN (
        'urgent',
        'high',
        'medium',
        'low'
    )),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    due_at TIMESTAMPTZ,
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    approval_status VARCHAR(16) NOT NULL DEFAULT 'not_required' CHECK (approval_status IN (
        'not_required',
        'pending',
        'approved',
        'rejected'
    )),
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution_note TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED
);

-- Comments on items (with @mention support)
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only activity log (immutability enforced via DB trigger in 003)
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action VARCHAR(50) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    note TEXT,
    is_org_admin_override BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency keys for mutations
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
    response_status INT,
    response_body JSONB,
    response_headers JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 minute'),
    CONSTRAINT uq_user_idempotency_key UNIQUE (user_id, key)
);

-- Outbox events for transactional asynchronous processing
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(100),
    lease_timeout_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Notifications generated from outbox events
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    dedupe_key VARCHAR(255) NOT NULL UNIQUE,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Simulated emails table
CREATE TABLE IF NOT EXISTS simulated_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SLA and stale scanner tracking to prevent duplicate scan notifications
CREATE TABLE IF NOT EXISTS sla_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key VARCHAR(255) NOT NULL UNIQUE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind VARCHAR(50) NOT NULL,
    window_label VARCHAR(50) NOT NULL,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
