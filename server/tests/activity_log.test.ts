import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db.js';
import { getTeamBySlug, getUserByEmail } from './helpers.js';

describe('Activity Log: Atomicity and Database Immutability Trigger', () => {
  let team: { id: string; name: string };
  let priyaUser: { id: string; email: string };
  let logId: string;

  beforeAll(async () => {
    team = await getTeamBySlug('operations');
    priyaUser = await getUserByEmail('priya.lead@newtonite.local');

    // Create a dummy item and activity log row for testing trigger immutability
    const itemRes = await pool.query(
      `INSERT INTO items (
        short_ref, team_id, type, title, description, status, priority, reporter_id, version
      )
      VALUES ($1, $2, 'operational_task', 'Immutability test target item', 'Description', 'new', 'low', $3, 1)
      RETURNING id`,
      [`OPS-TRIG-${Date.now()}`, team.id, priyaUser.id]
    );

    const logRes = await pool.query(
      `INSERT INTO activity_log (item_id, actor_id, action, note)
       VALUES ($1, $2, 'created', 'Initial immutability baseline event')
       RETURNING id`,
      [itemRes.rows[0].id, priyaUser.id]
    );

    logId = logRes.rows[0].id;
  });

  it('atomicity: rolling back a transaction leaves neither item mutation nor activity log persisted', async () => {
    const client = await pool.connect();
    const shortRef = `OPS-ROLLBACK-${Date.now()}`;

    try {
      await client.query('BEGIN');

      const itemRes = await client.query(
        `INSERT INTO items (
          short_ref, team_id, type, title, description, status, priority, reporter_id, version
        )
        VALUES ($1, $2, 'operational_task', 'Rolled back item', 'Description', 'new', 'low', $3, 1)
        RETURNING id`,
        [shortRef, team.id, priyaUser.id]
      );

      await client.query(
        `INSERT INTO activity_log (item_id, actor_id, action, note)
         VALUES ($1, $2, 'created', 'This log row should not survive rollback')`,
        [itemRes.rows[0].id, priyaUser.id]
      );

      // Force failure / rollback
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Verify neither item nor activity log exists
    const itemCheck = await pool.query('SELECT COUNT(*)::int as count FROM items WHERE short_ref = $1', [shortRef]);
    expect(itemCheck.rows[0].count).toBe(0);

    const logCheck = await pool.query(
      "SELECT COUNT(*)::int as count FROM activity_log WHERE note = 'This log row should not survive rollback'"
    );
    expect(logCheck.rows[0].count).toBe(0);
  });

  it('immutability trigger: rejects UPDATE on activity_log with exception', async () => {
    let thrownError: any = null;
    try {
      await pool.query(
        "UPDATE activity_log SET note = 'Tampered text attempt' WHERE id = $1",
        [logId]
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.message).toContain('activity_log is append-only and cannot be updated, deleted, or truncated');
  });

  it('immutability trigger: rejects DELETE on activity_log with exception', async () => {
    let thrownError: any = null;
    try {
      await pool.query('DELETE FROM activity_log WHERE id = $1', [logId]);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.message).toContain('activity_log is append-only and cannot be updated, deleted, or truncated');
  });

  it('immutability trigger: rejects TRUNCATE on activity_log with exception', async () => {
    let thrownError: any = null;
    try {
      await pool.query('TRUNCATE TABLE activity_log');
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.message).toContain('activity_log is append-only and cannot be updated, deleted, or truncated');
  });
});
