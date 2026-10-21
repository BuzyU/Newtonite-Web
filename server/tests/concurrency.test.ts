import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool, setPoolMax } from '../src/db.js';
import { resetWriteRateLimits } from '../src/rateLimit.js';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Concurrency: 50 concurrent claims on a single item', () => {
  let memberAuth: AuthContext;
  let team: { id: string; name: string; prefix: string };
  let testItemId: string;

  beforeAll(async () => {
    // Configure DB connection pool to match the database server max clients (10)
    process.env.DB_POOL_MAX = '10';
    setPoolMax(10);

    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');

    // Create a fresh open item with no assignee
    const client = authenticatedRequest(memberAuth);
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Concurrent claim benchmark target',
        description: 'Item created specifically to test 50 simultaneous atomic claim attempts.',
        priority: 'urgent',
        assigneeId: null,
      });

    expect(createRes.status).toBe(201);
    testItemId = createRes.body.item.id;
  });

  it('exactly one winner receives 200 OK, 49 receive 409 ALREADY_CLAIMED, and exactly one activity log entry is recorded', async () => {
    resetWriteRateLimits();
    // Prepare 50 simultaneous claim requests
    // Using distinct users or members to simulate concurrent workers
    const claimPromises = Array.from({ length: 50 }, (_, i) => {
      const client = authenticatedRequest(memberAuth);
      return client
        .post(`/api/v1/items/${testItemId}/claim`)
        .set('Idempotency-Key', `claim-race-${i}-${crypto.randomUUID()}`)
        .send();
    });

    const results = await Promise.all(claimPromises);

    const winners = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    const otherErrors = results.filter((r) => r.status !== 200 && r.status !== 409);

    expect(otherErrors).toHaveLength(0);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    // Verify 409 error envelope and currentAssignee presence
    for (const conflict of conflicts) {
      expect(conflict.body.error).toBeDefined();
      expect(conflict.body.error.code).toBe('ALREADY_CLAIMED');
      expect(conflict.body.error.currentAssignee).toBeDefined();
      expect(conflict.body.error.currentAssignee.id).toBe(memberAuth.user.id);
    }

    // Verify database state: item has assignee
    const itemRes = await pool.query('SELECT assignee_id, status FROM items WHERE id = $1', [testItemId]);
    expect(itemRes.rows[0].assignee_id).toBe(memberAuth.user.id);

    // Verify activity_log: exactly ONE 'claimed' entry recorded for this item
    const logRes = await pool.query(
      "SELECT id, action, actor_id FROM activity_log WHERE item_id = $1 AND action = 'claimed'",
      [testItemId]
    );
    expect(logRes.rows).toHaveLength(1);
    expect(logRes.rows[0].actor_id).toBe(memberAuth.user.id);
  });
});
