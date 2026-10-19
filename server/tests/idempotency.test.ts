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
});
