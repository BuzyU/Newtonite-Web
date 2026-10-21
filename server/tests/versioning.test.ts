import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../src/db.js';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Versioning & Optimistic Concurrency', () => {
  let memberAuth: AuthContext;
  let team: { id: string; name: string; prefix: string };
  let testItemId: string;
  let initialVersion: number;

  beforeAll(async () => {
    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');

    const client = authenticatedRequest(memberAuth);
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Optimistic concurrency test item',
        description: 'Item created for version validation tests.',
        priority: 'medium',
        assigneeId: memberAuth.user.id,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.headers.etag).toBe('"1"');
    testItemId = createRes.body.item.id;
    initialVersion = createRes.body.item.version;
  });

  it('rejects update without If-Match header with 428 PRECONDITION_REQUIRED', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client
      .patch(`/api/v1/items/${testItemId}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        title: 'Attempt update without If-Match',
      });

    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('rejects stale update with 412 STALE_VERSION, returns current item in body, leaves data and log unchanged', async () => {
    const client = authenticatedRequest(memberAuth);

    // Initial log count
    const initialLogRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM activity_log WHERE item_id = $1',
      [testItemId]
    );
    const initialLogCount = initialLogRes.rows[0].count;

    // Send update with stale version 999
    const res = await client
      .patch(`/api/v1/items/${testItemId}`)
      .set('If-Match', '"999"')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        title: 'Attempt update with stale version 999',
      });

    expect(res.status).toBe(412);
    expect(res.body.error.code).toBe('STALE_VERSION');
    expect(res.body.error.currentVersion).toBe(initialVersion);
    expect(res.body.error.currentItem).toBeDefined();
    expect(res.body.error.currentItem.id).toBe(testItemId);

    // Verify item in DB is unchanged
    const itemRes = await pool.query('SELECT title, version FROM items WHERE id = $1', [testItemId]);
    expect(itemRes.rows[0].version).toBe(initialVersion);
    expect(itemRes.rows[0].title).toBe('Optimistic concurrency test item');

    // Verify activity_log was not appended to
    const afterLogRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM activity_log WHERE item_id = $1',
      [testItemId]
    );
    expect(afterLogRes.rows[0].count).toBe(initialLogCount);
  });

  it('accepts update with matching If-Match header, increments version, and emits updated ETag', async () => {
    const client = authenticatedRequest(memberAuth);

    const res = await client
      .patch(`/api/v1/items/${testItemId}`)
      .set('If-Match', `"${initialVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        title: 'Successfully updated title with matching ETag',
      });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(`"${initialVersion + 1}"`);
    expect(res.body.item.version).toBe(initialVersion + 1);
    expect(res.body.item.title).toBe('Successfully updated title with matching ETag');

    // Database verification
    const itemRes = await pool.query('SELECT version, title FROM items WHERE id = $1', [testItemId]);
    expect(itemRes.rows[0].version).toBe(initialVersion + 1);
    expect(itemRes.rows[0].title).toBe('Successfully updated title with matching ETag');
  });

  it('rejects state transition with stale If-Match header with 412 STALE_VERSION', async () => {
    const client = authenticatedRequest(memberAuth);

    const res = await client
      .post(`/api/v1/items/${testItemId}/transition`)
      .set('If-Match', '"999"')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        status: 'triaged',
      });

    expect(res.status).toBe(412);
    expect(res.body.error.code).toBe('STALE_VERSION');
  });

  it('accepts state transition with matching If-Match header and increments version', async () => {
    const client = authenticatedRequest(memberAuth);
    const currentVersion = initialVersion + 1;

    const res = await client
      .post(`/api/v1/items/${testItemId}/transition`)
      .set('If-Match', `"${currentVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        status: 'triaged',
      });

    expect(res.status).toBe(200);
    expect(res.body.item.version).toBe(currentVersion + 1);
    expect(res.body.item.status).toBe('triaged');
  });

  it('strict schema validation: rejects mass-assignment of version, status, or created_by with 422 VALIDATION_ERROR', async () => {
    const client = authenticatedRequest(memberAuth);

    // Attempt to inject version/status in create item
    const createMalicious = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Malicious mass-assignment payload',
        description: 'Trying to inject version and status',
        version: 999,
        status: 'closed',
      });

    expect(createMalicious.status).toBe(422);
    expect(createMalicious.body.error.code).toBe('VALIDATION_ERROR');

    // Attempt to inject status or version in patch item
    const patchMalicious = await client
      .patch(`/api/v1/items/${testItemId}`)
      .set('If-Match', `"${initialVersion + 2}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        title: 'Valid title',
        status: 'closed', // status should only be changed via /transition
        version: 50,
      });

    expect(patchMalicious.status).toBe(422);
    expect(patchMalicious.body.error.code).toBe('VALIDATION_ERROR');
  });
});

