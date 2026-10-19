import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { pool } from '../src/db.js';
import { OutboxWorker } from '../src/worker.js';
import { getTeamBySlug, getUserByEmail } from './helpers.js';

describe('Outbox Worker & Reliable Async Processing', () => {
  let worker: OutboxWorker;
  let team: { id: string; name: string };
  let priyaUser: { id: string; email: string };
  let realItemId: string;

  beforeAll(async () => {
    worker = new OutboxWorker();
    team = await getTeamBySlug('operations');
    priyaUser = await getUserByEmail('priya.lead@newtonite.local');

    // Create a real item in database so foreign key references in notifications succeed
    const itemRes = await pool.query(
      `INSERT INTO items (
        short_ref, team_id, type, title, description, status, priority, reporter_id, version
      )
      VALUES ($1, $2, 'operational_task', 'Outbox worker test subject', 'Description', 'new', 'low', $3, 1)
      RETURNING id`,
      [`OPS-OUTBOX-${Date.now()}`, team.id, priyaUser.id]
    );
    realItemId = itemRes.rows[0].id;
  });

  beforeEach(async () => {
    // Clear pending queue so test rows are processed immediately by batch
    await pool.query("DELETE FROM outbox_events WHERE status IN ('pending', 'failed', 'processing')");
  });

  afterAll(() => {
    worker.stop();
  });

  it('deduplication: running outbox event processing twice creates only ONE notification', async () => {
    const eventId = crypto.randomUUID();

    // Insert an item.created event referencing realItemId
    await pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status)
       VALUES ($1, 'item.created', $2, 'pending')`,
      [
        eventId,
        JSON.stringify({
          itemId: realItemId,
          teamId: team.id,
          shortRef: 'OPS-9999',
          actorId: crypto.randomUUID(), // distinct actor so priya gets notified
        }),
      ]
    );

    // Process first time
    const count1 = await worker.processBatch();
    expect(count1).toBe(1);

    // Verify notification was created
    const notifRes1 = await pool.query(
      `SELECT COUNT(*)::int as count FROM notifications WHERE item_id = $1`,
      [realItemId]
    );
    expect(notifRes1.rows[0].count).toBeGreaterThan(0);
    const initialNotifCount = notifRes1.rows[0].count;

    // Simulate re-delivery or reprocessing of same event
    const fetchEvent = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [eventId]);
    await worker.handleSingleEvent(fetchEvent.rows[0]);

    // Notification count must remain unchanged due to unique dedupe_key
    const notifRes2 = await pool.query(
      `SELECT COUNT(*)::int as count FROM notifications WHERE item_id = $1`,
      [realItemId]
    );
    expect(notifRes2.rows[0].count).toBe(initialNotifCount);
  });

  it('retries with exponential backoff and transitions to dead_letter after max_attempts', async () => {
    const eventId = crypto.randomUUID();

    // Insert outbox event with attempts = 4, max_attempts = 5 and a payload with invalid non-existent foreign key
    await pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status, attempts, max_attempts)
       VALUES ($1, 'item.commented', $2, 'pending', 4, 5)`,
      [
        eventId,
        JSON.stringify({
          commentId: crypto.randomUUID(),
          itemId: crypto.randomUUID(), // non-existent item triggers FK violation
          content: 'Hello @priya.lead',
          mentionedEmails: ['priya.lead@newtonite.local'],
          authorId: priyaUser.id,
        }),
      ]
    );

    // Fetch and process
    const eventRes = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [eventId]);
    await worker.handleSingleEvent(eventRes.rows[0]);

    // Check status in DB: attempts reached 5 -> dead_letter
    const afterRes = await pool.query('SELECT status, attempts, last_error FROM outbox_events WHERE id = $1', [eventId]);
    expect(afterRes.rows[0].status).toBe('dead_letter');
    expect(afterRes.rows[0].attempts).toBe(5);
    expect(afterRes.rows[0].last_error).toBeDefined();
  });

  it('reclaims expired lease from a crashed worker', async () => {
    const eventId = crypto.randomUUID();

    // Simulate an event left in 'processing' by a crashed worker 10 minutes ago
    await pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status, attempts, locked_by, lease_timeout_at)
       VALUES ($1, 'item.created', $2, 'processing', 1, 'crashed-worker-xyz', NOW() - INTERVAL '5 minutes')`,
      [
        eventId,
        JSON.stringify({
          itemId: realItemId,
          teamId: team.id,
          shortRef: 'OPS-CRASH',
          actorId: crypto.randomUUID(),
        }),
      ]
    );

    // When worker polls batch, it reclaims the expired lease row
    const processed = await worker.processBatch();
    expect(processed).toBe(1);

    const checkRes = await pool.query('SELECT status, locked_by FROM outbox_events WHERE id = $1', [eventId]);
    expect(checkRes.rows[0].status).toBe('completed');
  });

  it('SLA scanner run twice produces idempotent notifications per item and window', async () => {
    // Run SLA scanner first time
    await worker.runSlaScanner();

    // Count sla_checks
    const count1 = await pool.query('SELECT COUNT(*)::int as count FROM sla_checks');

    // Run SLA scanner second time immediately
    const newlyCreated = await worker.runSlaScanner();
    expect(newlyCreated).toBe(0); // No duplicate events generated for the same calendar window

    const count2 = await pool.query('SELECT COUNT(*)::int as count FROM sla_checks');
    expect(count2.rows[0].count).toBe(count1.rows[0].count);
  });
});
