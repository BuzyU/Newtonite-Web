import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../src/db.js';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Idempotency: mutating endpoint idempotency keys', () => {
  let memberAuth: AuthContext;
  let team: { id: string; name: string; prefix: string };

  beforeAll(async () => {
    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');
  });

  it('replaying the same idempotency key with identical body returns stored response and creates only ONE row in database', async () => {
    const client = authenticatedRequest(memberAuth);
    const key = `idem-replay-${crypto.randomUUID()}`;
    const uniqueTitle = `Idempotency replay test ${crypto.randomUUID()}`;

    const payload = {
      teamId: team.id,
      type: 'operational_task',
      title: uniqueTitle,
      description: 'Testing exact response replay on identical duplicate submissions.',
      priority: 'low',
    };

    // First request
    const firstRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send(payload);

    expect(firstRes.status).toBe(201);
    const createdItemId = firstRes.body.item.id;

    // Second request: replayed with same key and same body
    const secondRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send(payload);

    expect(secondRes.status).toBe(201);
    expect(secondRes.headers['x-idempotent-replay']).toBe('true');
    expect(secondRes.body.item.id).toBe(createdItemId);
    expect(secondRes.body.item.short_ref).toBe(firstRes.body.item.short_ref);

    // Verify database contains only ONE item with this unique title
    const countRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM items WHERE title = $1 AND team_id = $2',
      [uniqueTitle, team.id]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  it('rejects replayed idempotency key with different body payload with 422', async () => {
    const client = authenticatedRequest(memberAuth);
    const key = `idem-diff-${crypto.randomUUID()}`;
    const uniqueTitle = `Original payload item ${crypto.randomUUID()}`;

    const originalPayload = {
      teamId: team.id,
      type: 'operational_task',
      title: uniqueTitle,
      description: 'Original description content.',
    };

    const firstRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send(originalPayload);

    expect(firstRes.status).toBe(201);

    // Replay with altered payload
    const alteredPayload = {
      teamId: team.id,
      type: 'operational_task',
      title: `TAMPERED title ${crypto.randomUUID()}`,
      description: 'Original description content.',
    };

    const secondRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send(alteredPayload);

    expect(secondRes.status).toBe(422);
    expect(secondRes.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('two simultaneous identical requests: one executes, the other gets stored response or 409 REQUEST_IN_PROGRESS', async () => {
    const client = authenticatedRequest(memberAuth);
    const key = `idem-simultaneous-${crypto.randomUUID()}`;
    const uniqueTitle = `Simultaneous duplicate item ${crypto.randomUUID()}`;

    const payload = {
      teamId: team.id,
      type: 'operational_task',
      title: uniqueTitle,
      description: 'Testing concurrent duplicate detection.',
    };

    const [res1, res2] = await Promise.all([
      client.post('/api/v1/items').set('Idempotency-Key', key).send(payload),
      client.post('/api/v1/items').set('Idempotency-Key', key).send(payload),
    ]);

    // One must be 201 (success), and the other must be either 201 (replayed stored response) or 409 (REQUEST_IN_PROGRESS)
    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);

    if (statuses.includes(409)) {
      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe('REQUEST_IN_PROGRESS');
      expect(conflictRes.headers['retry-after']).toBeDefined();
    }

    // Exactly one row created in items
    const countRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM items WHERE title = $1 AND team_id = $2',
      [uniqueTitle, team.id]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  it('CONC-01: Reusing the same key on a different path or method does not replay or collide across endpoints', async () => {
    const client = authenticatedRequest(memberAuth);
    const key = `idem-route-scope-${crypto.randomUUID()}`;

    // Create item 1
    const resItem1 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: `Item 1 for claim ${crypto.randomUUID()}`,
        description: 'Testing route scoping in idempotency hash.',
      });
    expect(resItem1.status).toBe(201);
    const item1Id = resItem1.body.item.id;

    // Create item 2
    const resItem2 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: `Item 2 for claim ${crypto.randomUUID()}`,
        description: 'Testing route scoping in idempotency hash.',
      });
    expect(resItem2.status).toBe(201);
    const item2Id = resItem2.body.item.id;

    // First claim on item 1 with key
    const claim1 = await client
      .post(`/api/v1/items/${item1Id}/claim`)
      .set('Idempotency-Key', key)
      .send({});
    expect(claim1.status).toBe(200);

    // Second claim on item 2 with SAME key and SAME body {}
    const claim2 = await client
      .post(`/api/v1/items/${item2Id}/claim`)
      .set('Idempotency-Key', key)
      .send({});

    // If method + path is included in hash, this payload mismatch triggers 422 IDEMPOTENCY_PAYLOAD_MISMATCH
    // rather than falsely returning 200 with item 1's claim response!
    expect(claim2.status).toBe(422);
    expect(claim2.body.error?.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('canonicalizes body key order: retrying with differently ordered keys matches hash and replays response', async () => {
    const client = authenticatedRequest(memberAuth);
    const key = `idem-canonical-${crypto.randomUUID()}`;
    const uniqueTitle = `Canonical test item ${crypto.randomUUID()}`;

    // Request 1: keys in order [teamId, type, title, description, priority]
    const res1 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: uniqueTitle,
        description: 'Testing canonical JSON stringification.',
        priority: 'high',
      });

    expect(res1.status).toBe(201);
    const originalItemId = res1.body.item.id;

    // Request 2: exact same data but keys in REVERSE order [priority, description, title, type, teamId]
    const res2 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', key)
      .send({
        priority: 'high',
        description: 'Testing canonical JSON stringification.',
        title: uniqueTitle,
        type: 'operational_task',
        teamId: team.id,
      });

    expect(res2.status).toBe(201);
    expect(res2.headers['x-idempotent-replay']).toBe('true');
    expect(res2.body.item.id).toBe(originalItemId);
  });

  it('scopes idempotency keys per user: two users using the identical key never collide', async () => {
    const userA = memberAuth; // Elena
    const userB = await loginAs('david.member@newtonite.local'); // David

    const sharedKey = `shared-idem-key-${crypto.randomUUID()}`;

    // User A submits
    const resA = await authenticatedRequest(userA)
      .post('/api/v1/items')
      .set('Idempotency-Key', sharedKey)
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: `User A item ${crypto.randomUUID()}`,
        description: 'Elena submission with shared key.',
      });

    expect(resA.status).toBe(201);

    // User B submits with the SAME key and different body
    const resB = await authenticatedRequest(userB)
      .post('/api/v1/items')
      .set('Idempotency-Key', sharedKey)
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: `User B item ${crypto.randomUUID()}`,
        description: 'David submission with same key name.',
      });

    // Scoped per user -> User B gets 201 created (not 422 payload mismatch or 409)
    expect(resB.status).toBe(201);
    expect(resB.body.item.id).not.toBe(resA.body.item.id);
  });

  it('5xx deletion safety: completeIdempotency cannot delete a record once it reaches completed status', async () => {
    const { completeIdempotency } = await import('../src/idempotency.js');
    const testKey = `test-committed-key-${crypto.randomUUID()}`;
    const testUserId = memberAuth.user.id;

    const client = await pool.connect();
    try {
      // 1. Insert and complete an idempotency key
      await client.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash, status, response_status, response_body)
         VALUES ($1, $2, 'test-hash', 'completed', 200, '{"success":true}')`,
        [testUserId, testKey]
      );

      // 2. Attempt a 500 error deletion on this key
      await completeIdempotency(client, testUserId, testKey, 500, { error: 'Simulated 500' });

      // 3. Verify the row was NOT deleted because status == 'completed'
      const checkRes = await client.query(
        `SELECT status, response_status FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [testUserId, testKey]
      );

      expect(checkRes.rows).toHaveLength(1);
      expect(checkRes.rows[0].status).toBe('completed');
      expect(checkRes.rows[0].response_status).toBe(200);
    } finally {
      await client.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [testUserId, testKey]);
      client.release();
    }
  });
});


