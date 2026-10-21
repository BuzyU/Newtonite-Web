import { pool } from '../src/db.js';

async function main() {
  await pool.query(`
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
  `);
  console.log('Trigger successfully updated in DB.');
  await pool.end();
}

main();
