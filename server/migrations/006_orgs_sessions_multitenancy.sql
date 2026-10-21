-- 006_orgs_sessions_multitenancy.sql
-- Multi-tenancy (organizations + org_id), Postgres-backed sessions, admin audit log,
-- Postgres rate limits, change feed (polling realtime). Removes Google/Supabase columns.
--
-- Deliberate deviation: org_id is NOT added to activity_log / comments / notifications /
-- idempotency_keys. activity_log is immutable (migration 003) so it cannot be backfilled, and
-- every one of those rows is reachable only through an item or user that already carries org_id.

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(50) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: if legacy single-tenant data exists, it becomes the demo org.
INSERT INTO organizations (name, slug)
SELECT 'Newtonite Demo', 'newtonite-demo'
WHERE EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM teams)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE users SET org_id = (SELECT id FROM organizations WHERE slug = 'newtonite-demo') WHERE org_id IS NULL;
UPDATE teams SET org_id = (SELECT id FROM organizations WHERE slug = 'newtonite-demo') WHERE org_id IS NULL;
UPDATE items SET org_id = t.org_id FROM teams t WHERE t.id = items.team_id AND items.org_id IS NULL;
UPDATE outbox_events SET org_id = t.org_id FROM teams t
  WHERE outbox_events.org_id IS NULL AND (outbox_events.payload->>'teamId') = t.id::text;

ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE teams ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE items ALTER COLUMN org_id SET NOT NULL;

-- Uniqueness becomes per-org (emails stay globally unique: one org per user).
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_key;
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_slug_key;
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_prefix_key;
ALTER TABLE teams ADD CONSTRAINT uq_teams_org_name UNIQUE (org_id, name);
ALTER TABLE teams ADD CONSTRAINT uq_teams_org_slug UNIQUE (org_id, slug);
ALTER TABLE teams ADD CONSTRAINT uq_teams_org_prefix UNIQUE (org_id, prefix);
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_short_ref_key;
ALTER TABLE items ADD CONSTRAINT uq_items_org_short_ref UNIQUE (org_id, short_ref);

CREATE INDEX IF NOT EXISTS idx_items_org_activity ON items (org_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (org_id);
CREATE INDEX IF NOT EXISTS idx_outbox_org ON outbox_events (org_id);

-- User account state
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Remove third-party auth (Google/Supabase) columns
DROP INDEX IF EXISTS idx_users_external_id;
ALTER TABLE users DROP COLUMN IF EXISTS external_id;
ALTER TABLE users DROP COLUMN IF EXISTS auth_provider;

-- Sessions (token stored only as a hash)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    remember BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    ip VARCHAR(64),
    user_agent VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Immutable admin audit log (separate trigger function from activity_log)
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    actor_id UUID REFERENCES users(id),
    action VARCHAR(60) NOT NULL,
    target_type VARCHAR(40),
    target_id VARCHAR(80),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_org_created ON admin_audit_log (org_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION enforce_admin_audit_immutability() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_log is immutable: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_immutable ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION enforce_admin_audit_immutability();
DROP TRIGGER IF EXISTS trg_admin_audit_immutable_truncate ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_immutable_truncate BEFORE TRUNCATE ON admin_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION enforce_admin_audit_immutability();

-- Postgres-backed fixed-window rate limits (works across serverless instances)
CREATE TABLE IF NOT EXISTS rate_limits (
    scope VARCHAR(40) NOT NULL,
    key VARCHAR(200) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, key, window_start)
);

-- Change feed (polling replaces SSE): one row per item insert/update
CREATE TABLE IF NOT EXISTS change_feed (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID NOT NULL,
    team_id UUID NOT NULL,
    item_id UUID NOT NULL,
    version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_change_feed_org_id ON change_feed (org_id, id);

-- Tenant-integrity triggers ---------------------------------------------------

CREATE OR REPLACE FUNCTION items_enforce_org() RETURNS TRIGGER AS $$
DECLARE
    team_org UUID;
    other_org UUID;
BEGIN
    SELECT org_id INTO team_org FROM teams WHERE id = NEW.team_id;
    IF team_org IS NULL THEN
        RAISE EXCEPTION 'team % not found', NEW.team_id USING ERRCODE = '23503';
    END IF;
    IF NEW.org_id IS NULL THEN
        NEW.org_id := team_org;
    ELSIF NEW.org_id <> team_org THEN
        RAISE EXCEPTION 'item org does not match team org' USING ERRCODE = '23514';
    END IF;
    IF NEW.assignee_id IS NOT NULL THEN
        SELECT org_id INTO other_org FROM users WHERE id = NEW.assignee_id;
        IF other_org IS DISTINCT FROM NEW.org_id THEN
            RAISE EXCEPTION 'assignee belongs to a different organization' USING ERRCODE = '23514';
        END IF;
    END IF;
    SELECT org_id INTO other_org FROM users WHERE id = NEW.reporter_id;
    IF other_org IS DISTINCT FROM NEW.org_id THEN
        RAISE EXCEPTION 'reporter belongs to a different organization' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_items_enforce_org ON items;
CREATE TRIGGER trg_items_enforce_org BEFORE INSERT OR UPDATE OF team_id, assignee_id, reporter_id, org_id ON items
    FOR EACH ROW EXECUTE FUNCTION items_enforce_org();

CREATE OR REPLACE FUNCTION memberships_enforce_org() RETURNS TRIGGER AS $$
DECLARE
    t_org UUID;
    u_org UUID;
BEGIN
    SELECT org_id INTO t_org FROM teams WHERE id = NEW.team_id;
    SELECT org_id INTO u_org FROM users WHERE id = NEW.user_id;
    IF t_org IS DISTINCT FROM u_org THEN
        RAISE EXCEPTION 'cross-organization team membership is not allowed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memberships_enforce_org ON team_memberships;
CREATE TRIGGER trg_memberships_enforce_org BEFORE INSERT OR UPDATE ON team_memberships
    FOR EACH ROW EXECUTE FUNCTION memberships_enforce_org();

CREATE OR REPLACE FUNCTION outbox_fill_org() RETURNS TRIGGER AS $$
DECLARE
    resolved UUID;
BEGIN
    IF NEW.org_id IS NULL THEN
        BEGIN
            SELECT org_id INTO resolved FROM teams WHERE id = (NEW.payload->>'teamId')::uuid;
            IF resolved IS NULL THEN
                SELECT org_id INTO resolved FROM items WHERE id = (NEW.payload->>'itemId')::uuid;
            END IF;
        EXCEPTION WHEN others THEN
            resolved := NULL;
        END;
        NEW.org_id := resolved;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_outbox_fill_org ON outbox_events;
CREATE TRIGGER trg_outbox_fill_org BEFORE INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION outbox_fill_org();

CREATE OR REPLACE FUNCTION items_change_feed() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO change_feed (org_id, team_id, item_id, version)
    VALUES (NEW.org_id, NEW.team_id, NEW.id, NEW.version);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_items_change_feed ON items;
CREATE TRIGGER trg_items_change_feed AFTER INSERT OR UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION items_change_feed();

-- RLS on all new tables (no policies: only the owning API role bypasses; PostgREST/anon denied)
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_feed ENABLE ROW LEVEL SECURITY;
