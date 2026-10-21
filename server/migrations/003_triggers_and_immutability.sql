-- 003_triggers_and_immutability.sql
-- Enforces immutability of activity_log via DB trigger
-- Real-time Postgres NOTIFY triggers for instant SSE fanout

-- 1. Activity log immutability trigger
CREATE OR REPLACE FUNCTION enforce_activity_log_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'activity_log is append-only and cannot be updated, deleted, or truncated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_log_immutable_update_delete ON activity_log;
CREATE TRIGGER trg_activity_log_immutable_update_delete
BEFORE UPDATE OR DELETE ON activity_log
FOR EACH ROW
EXECUTE FUNCTION enforce_activity_log_immutability();

DROP TRIGGER IF EXISTS trg_activity_log_immutable_truncate ON activity_log;
CREATE TRIGGER trg_activity_log_immutable_truncate
BEFORE TRUNCATE ON activity_log
EXECUTE FUNCTION enforce_activity_log_immutability();

-- 2. Realtime NOTIFY trigger on outbox_events insert
-- This notifies the dedicated LISTEN client which fans out events to SSE clients
CREATE OR REPLACE FUNCTION notify_outbox_event_created()
RETURNS TRIGGER AS $$
DECLARE
    payload_json JSONB;
BEGIN
    payload_json := json_build_object(
        'id', NEW.id,
        'event_type', NEW.event_type,
        'team_id', COALESCE(NEW.payload->>'team_id', NEW.payload->>'teamId'),
        'item_id', COALESCE(NEW.payload->>'item_id', NEW.payload->>'itemId'),
        'version', NEW.payload->>'version',
        'created_at', NEW.created_at
    );
    PERFORM pg_notify('newtonite_events', payload_json::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_outbox_notify ON outbox_events;
CREATE TRIGGER trg_outbox_notify
AFTER INSERT ON outbox_events
FOR EACH ROW
EXECUTE FUNCTION notify_outbox_event_created();
